'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../security-policy-check');

const ROOT = path.resolve(__dirname, '..', '..');
let PASS = 0;
let FAIL = 0;
function test(name, fn) {
  try {
    fn();
    PASS += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    FAIL += 1;
    console.log(`  FAIL ${name}\n     ${error.message}`);
  }
}

function withFixture(version, security, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-security-policy-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: '@sdsrs/agentsmd', version })}\n`);
    if (security !== null) fs.writeFileSync(path.join(root, 'SECURITY.md'), security);
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const policy = (major) => [
  '# Security policy',
  '',
  '## Supported versions',
  '',
  `Only the **latest published minor of the ${major}.x line** receives security fixes. Older versions must upgrade.`,
  '',
  '## Threat model',
  '',
  'Historical provenance began at v4.19.0.',
  '',
].join('\n');

test('real repository support major matches package major', () => {
  const result = S.runSecurityPolicyCheck({ root: ROOT });
  assert.strictEqual(result.ok, true, JSON.stringify(result, null, 2));
  assert.strictEqual(result.packageVersion, require('../../package.json').version);
  assert.strictEqual(result.declaredMajor, result.expectedMajor);
});

test('matching major passes while historical version prose stays irrelevant', () => {
  withFixture('9.4.1', policy(9), (root) => {
    const result = S.runSecurityPolicyCheck({ root });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.expectedMajor, '9');
    assert.strictEqual(result.declaredMajor, '9');
  });
});

test('stale supported major fails with a machine-readable mismatch', () => {
  withFixture('9.4.1', policy(8), (root) => {
    const result = S.runSecurityPolicyCheck({ root });
    assert.strictEqual(result.ok, false);
    assert(result.offenders.some((entry) => entry.code === 'support-major-mismatch'));
  });
});

test('missing, duplicate, and malformed Supported versions contracts fail closed', () => {
  const cases = [
    [null, 'security-file-missing'],
    [policy(9).replace('## Supported versions', '## Scope'), 'supported-section-count'],
    [`${policy(9)}\n## Supported versions\n\n${policy(9).split('\n')[4]}\n`, 'supported-section-count'],
    [policy(9).replace('latest published minor', 'all published minors'), 'support-policy-shape'],
  ];
  for (const [security, code] of cases) {
    withFixture('9.4.1', security, (root) => {
      const result = S.runSecurityPolicyCheck({ root });
      assert.strictEqual(result.ok, false, `${code}: ${JSON.stringify(result)}`);
      assert(result.offenders.some((entry) => entry.code === code), JSON.stringify(result));
    });
  }
});

test('invalid package SemVer and symlinked SECURITY.md are rejected', () => {
  withFixture('09.4.1', policy(9), (root) => {
    const result = S.runSecurityPolicyCheck({ root });
    assert(result.offenders.some((entry) => entry.code === 'package-version-invalid'));
  });
  withFixture('9.4.1', null, (root) => {
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, policy(9));
    fs.symlinkSync(outside, path.join(root, 'SECURITY.md'));
    const result = S.runSecurityPolicyCheck({ root });
    assert(result.offenders.some((entry) => entry.code === 'security-file-unsafe'));
  });
});

test('CLI emits JSON and rejects unknown argv with exit 2', () => {
  const script = path.join(ROOT, 'scripts', 'security-policy-check.js');
  const output = cp.execFileSync(process.execPath, [script, '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(output).ok, true);
  const bad = cp.spawnSync(process.execPath, [script, '--nope'], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /Unknown flag/);
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
