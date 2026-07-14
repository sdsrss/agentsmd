'use strict';
// version-cascade-check.js — free-text version-drift gate. drift.test.js gate #5
// asserts the version matches across the 5 STRUCTURED places (package.json,
// .codex-plugin/plugin.json, hard-rules.json spec_version, and the two spec
// headers). This complements it by scanning PROSE — the READMEs — for a
// same-major version token drifted off the current minor (e.g. a "current
// version vX.Y" claim left stale after a bump). drift #5 reads named JSON fields;
// this reads narrative text those fields never cover. Intentional historical
// refs (the rename version) are allowlisted by exact token. Ported from
// claudemd/scripts/version-cascade-check.js (ESM→CJS).

const fs = require('fs');
const path = require('path');
const { ArgvError, printHelpAndExit, parseStrict } = require('./lib/argv');

// Prose files carrying version tokens that drift #5 does NOT version-assert.
const SCANNED_FILES = ['README.md', 'README.zh-CN.md'];

// Exact v-prefixed tokens that are deliberately fixed historical/example refs —
// never "the current version", so never stale, yet same-major so they'd otherwise
// trip the scan. Stable constants: a past rename version can't become current
// again. A new deliberate historical ref = a conscious addition here.
const INTENTIONAL_TOKENS = new Set(['v2.0.0']);

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// Collapse a version token to v<major>.<minor> (patch-insensitive) for comparison.
function toMinor(token) {
  const m = String(token).match(/^v?(\d+)\.(\d+)/);
  return m ? `v${m[1]}.${m[2]}` : null;
}

// A regex matching v-prefixed tokens of the CURRENT major only, derived per run —
// never a fixed /v2\./ that would go silent after a major bump and miss drift. The
// leading `(?<![\w.])` boundary keeps a version-shaped substring glued to a preceding
// word char or dot (e.g. `libv2.1`, `x.v2.1`) from registering as a stray token.
function majorTokenRe(specVersion) {
  const m = String(specVersion).match(/^v?(\d+)\./);
  if (!m) throw new Error(`unparseable spec_version: ${specVersion}`);
  return new RegExp(`(?<![\\w.])v${m[1]}\\.\\d+(?:\\.\\d+)?`, 'g');
}

function runVersionCascadeCheck({ root = path.join(__dirname, '..') } = {}) {
  const hr = JSON.parse(fs.readFileSync(path.join(root, 'spec', 'hard-rules.json'), 'utf8'));
  const specVersion = hr.spec_version;
  const expectedMinor = toMinor(specVersion);
  const tokenRe = majorTokenRe(specVersion);
  const offenders = [];
  const filesChecked = [];
  for (const rel of SCANNED_FILES) {
    const content = readOrNull(path.join(root, rel));
    if (content === null) {
      offenders.push({ file: rel, line: 0, found: null, expected: expectedMinor, context: '<file missing>' });
      continue;
    }
    filesChecked.push(rel);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].match(tokenRe);
      if (!matches) continue;
      for (const found of matches) {
        if (INTENTIONAL_TOKENS.has(found)) continue;
        if (toMinor(found) !== expectedMinor) {
          offenders.push({ file: rel, line: i + 1, found, expected: expectedMinor, context: lines[i].trim().slice(0, 140) });
        }
      }
    }
  }
  return { ok: offenders.length === 0, specVersion, expectedMinor, filesChecked, offenders };
}

function formatReport(r) {
  const L = [];
  L.push(`version-cascade — spec_version ${r.specVersion} (expected minor ${r.expectedMinor})`);
  L.push(`scanned ${r.filesChecked.length} prose file(s): ${r.filesChecked.join(', ') || '(none)'}`);
  if (r.ok) {
    L.push('ok — no stale same-major version token in prose.');
  } else {
    L.push(`${r.offenders.length} stale/missing version token(s):`);
    for (const o of r.offenders) L.push(`  ${o.file}:${o.line} — found ${o.found || '(file missing)'} (expected ${o.expected})  ${o.context}`);
    L.push('If a token is a deliberate historical/example ref, add it to INTENTIONAL_TOKENS.');
  }
  return L.join('\n');
}

if (require.main === module) {
  const usage = 'Usage: agentsmd-version-cascade [--json]';
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, usage);
  let opts;
  try { opts = parseStrict(argv, { bools: ['json'] }); }
  catch (e) {
    if (e instanceof ArgvError) { console.error(`agentsmd version-cascade: ${e.message}\n${usage}`); process.exit(2); }
    throw e;
  }
  const r = runVersionCascadeCheck();
  console.log(opts.bools.has('json') ? JSON.stringify(r, null, 2) : formatReport(r));
  process.exit(r.ok ? 0 : 1);
}
module.exports = { runVersionCascadeCheck, formatReport, toMinor, majorTokenRe, SCANNED_FILES, INTENTIONAL_TOKENS };
