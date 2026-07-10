'use strict';
// doctor.js — health checks for an agentsmd install + spec integrity.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const P = require('./lib/paths');
const CT = require('./lib/config-toml');
const H = require('./lib/codex-hooks');
const REG = require('./lib/hook-registry');
const F = require('./lib/fs-atomic');
const { parseNoArgs } = require('./status');

const REQUIRED_HOOK_SUPPORT = [
  'hooks.json',
  'banned-vocab.patterns',
  'secrets.patterns',
  'lib/hook-common.sh',
  'lib/platform.sh',
  'lib/rule-hits.sh',
  'lib/command-parse.js',
];

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const has = (bin) => { try { cp.execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; } };

function doctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

  add('jq present', has('jq'), 'hooks require jq');
  add('node present', has('node'), 'transcript scan + scripts require node');

  const cfg = read(P.configTomlPath()) || '';
  add('config.toml features.hooks=true', CT.isCodexHooksEnabled(cfg), 'Codex native hooks enabled ([features] hooks; legacy codex_hooks also recognized)');
  const statusLine = CT.getTuiStatusLine(cfg);
  const statusLineOk = statusLine.exists && statusLine.items !== null;
  add(
    'config.toml tui.status_line configured',
    statusLineOk,
    CT.isAgentsmdStatusLineEnabled(cfg) ? 'agentsmd preset' : (statusLine.exists ? (statusLineOk ? 'custom' : 'unparseable') : 'missing')
  );

  // Expected hook count comes from the hook-registry (single source of truth);
  // hook-registry.test.js asserts the registry never drifts from either hooks.json
  // wiring, so this stays equivalent to the old template-parse without re-reading it.
  const expectedHooks = REG.HOOK_REGISTRY.length;
  const rawHooks = read(P.hooksJsonPath());
  // hooks.json parseable? countAgentsmdHooks returns 0 on an UNPARSEABLE file exactly
  // as it does for "no agentsmd hooks" — but an unparseable SHARED hooks.json is a
  // distinct, worse state: install AND uninstall both abort on it (they refuse to
  // clobber a file that may hold other tenants' hooks), so every management command
  // is wedged until it's fixed. Surface it instead of hiding it behind a bare 0/15.
  const hooksParseable = rawHooks === null || rawHooks.trim() === '' || H.parseHooksConfig(rawHooks) !== null;
  add('hooks.json parseable', hooksParseable, hooksParseable ? 'ok' : 'UNPARSEABLE — install/uninstall abort on this; fix or remove ~/.codex/hooks.json');
  const registeredHooks = H.countAgentsmdHooks(rawHooks || '');
  const manifestRaw = read(P.manifestPath());
  const manifestInstalled = manifestRaw !== null;
  let manifest = null;
  try { manifest = manifestRaw === null ? null : JSON.parse(manifestRaw); } catch {}
  add(
    'agentsmd hooks registered',
    hooksParseable && registeredHooks === expectedHooks,
    hooksParseable ? `${registeredHooks}/${expectedHooks}` : `unknown — hooks.json unparseable`
  );
  // Install-state consistency: install writes the manifest LAST, so hooks live in the
  // shared hooks.json with NO manifest means a crash between the hooks-merge and the
  // manifest-write (or a manually-removed state dir). status.installed reads false off
  // the manifest while the hooks actually run — a contradiction doctor must name, not
  // report as two unrelated lines ("15/15 ok" + "not installed").
  add(
    'install state consistent (manifest vs live hooks)',
    !(!manifestInstalled && registeredHooks > 0),
    (!manifestInstalled && registeredHooks > 0)
      ? `partial install — ${registeredHooks} hooks live in hooks.json but no manifest (crash mid-install or state dir removed) — re-run install.js`
      : 'ok'
  );

  const hooksDir = P.installHooksDir();
  if (!manifestInstalled) {
    add('installed hooks executable', false, 'not installed');
  } else {
    const bad = [];
    for (const hook of REG.HOOK_REGISTRY) {
      const file = path.join(hooksDir, hook.basename);
      try { fs.accessSync(file, fs.constants.X_OK); } catch { bad.push(hook.basename); }
    }
    add('installed hooks executable', bad.length === 0, bad.length ? `missing/not executable: ${bad.join(', ')}` : `${REG.HOOK_REGISTRY.length}/${REG.HOOK_REGISTRY.length}`);
  }

  // The manifest inventories the complete deployed release, including support
  // libraries and pattern files that a top-level executable scan cannot see.
  const integrityFailures = [];
  if (!manifestInstalled) {
    integrityFailures.push('not installed');
  } else if (!manifest || !Array.isArray(manifest.deployedFiles)) {
    integrityFailures.push('manifest has no deployed file inventory — re-run install');
  } else {
    const root = path.resolve(P.installDir());
    if (manifest.name !== 'agentsmd' || typeof manifest.version !== 'string' || !manifest.version) {
      integrityFailures.push('manifest identity/version invalid');
    }
    if (manifest.deployedFiles.length === 0) integrityFailures.push('manifest deploy inventory is empty');
    for (const relative of REQUIRED_HOOK_SUPPORT) {
      if (!fs.existsSync(path.join(hooksDir, relative))) integrityFailures.push(`hooks/${relative}`);
    }
    const expected = new Map();
    for (const record of manifest.deployedFiles) {
      const file = path.resolve(root, record.path || '');
      const validType = record.type === 'file' || record.type === 'symlink';
      const validHash = record.type !== 'file' || /^[a-f0-9]{64}$/.test(record.sha256 || '');
      const validTarget = record.type !== 'symlink' || typeof record.target === 'string';
      if (!record.path || expected.has(record.path) || !validType || !validHash || !validTarget) {
        integrityFailures.push(`invalid inventory record: ${record.path || '(empty)'}`);
        continue;
      }
      if (file === root || !file.startsWith(root + path.sep)) {
        integrityFailures.push(`invalid manifest path: ${record.path}`);
        continue;
      }
      expected.set(record.path, record);
    }
    let actual = [];
    try { actual = F.treeEntries(root).filter((entry) => entry.type !== 'dir'); }
    catch (error) { integrityFailures.push(`cannot inventory deploy: ${error.message}`); }
    const actualMap = new Map(actual.map((entry) => [entry.path, entry]));
    for (const [relative, record] of expected) {
      const entry = actualMap.get(relative);
      if (!entry || entry.type !== record.type
          || (record.type === 'file' && entry.sha256 !== record.sha256)
          || (record.type === 'symlink' && entry.target !== record.target)) integrityFailures.push(relative);
    }
    for (const relative of actualMap.keys()) {
      if (!expected.has(relative)) integrityFailures.push(`unexpected: ${relative}`);
    }
  }
  add(
    'installed hook and support files intact',
    integrityFailures.length === 0,
    integrityFailures.length ? [...new Set(integrityFailures)].slice(0, 5).join(', ') : `${manifest.deployedFiles.length}/${manifest.deployedFiles.length}`
  );

  // hard-rules anchors resolve against the spec (drift guard).
  try {
    const hr = JSON.parse(read(path.join(P.repoRoot(), 'spec', 'hard-rules.json')));
    const files = {
      core: read(path.join(P.repoRoot(), 'spec', 'AGENTS.md')) || '',
      extended: read(path.join(P.repoRoot(), 'spec', 'AGENTS-extended.md')) || '',
    };
    const miss = hr.rules.filter((r) => !files[r.scope].includes(r.section_anchor));
    add('hard-rules anchors resolve', miss.length === 0, miss.length ? `${miss.length} missing` : `${hr.rules.length}/${hr.rules.length}`);
  } catch (e) { add('hard-rules anchors resolve', false, e.message); }

  // Extended spec must exist at the top-level path core §2/§5 order the agent to
  // `cat` (~/.codex/AGENTS-extended.md) AND match the copy in the install dir — a
  // missing/stale target silently strips every L3/ship/override/three-strike rule.
  const extTop = read(P.agentsExtendedMdPath());
  const extSrc = read(path.join(P.installSpecDir(), 'AGENTS-extended.md'));
  add(
    'AGENTS-extended.md installed at ~/.codex/',
    extTop !== null && extSrc !== null && extTop === extSrc,
    extTop === null ? 'missing — run install' : (extSrc === null ? 'not installed' : (extTop === extSrc ? 'ok' : 'stale — re-run install'))
  );

  // Installed-spec freshness: the spec version deployed into ~/.codex/AGENTS.md vs
  // the version this doctor's spec source carries. A lagging deploy (package bumped
  // but `install` never re-run) means new hooks/rules aren't live and the telemetry
  // loop starves (OPERATOR §O4). Only meaningful when doctor runs from a source
  // newer than the deploy (repo / freshly-updated package); run from the installed
  // copy the two match by construction, so this never false-fails there.
  const srcVer = ((read(path.join(P.repoRoot(), 'spec', 'AGENTS.md')) || '').match(/CODEX-CODING-SPEC v(\d+\.\d+\.\d+)/) || [])[1];
  const depVer = ((read(P.agentsMdPath()) || '').match(/CODEX-CODING-SPEC v(\d+\.\d+\.\d+)/) || [])[1];
  if (srcVer) {
    add(
      'installed spec is current',
      depVer === srcVer,
      !depVer ? 'no CODEX-CODING-SPEC block in ~/.codex/AGENTS.md — run install.js'
        : (depVer === srcVer ? `v${depVer}` : `deployed v${depVer} != source v${srcVer} — re-run install.js`)
    );
  }

  // Discovery-chain budget: the global ~/.codex/AGENTS.md shares
  // project_doc_max_bytes (default 32 KiB) with every project's AGENTS.md chain,
  // and truncation past the cap is SILENT. Report the global spec's byte footprint
  // and the headroom left for project docs. Only fails if the global ALONE exceeds
  // the cap (thin-but-positive headroom is informational, never a false fail).
  const globalBytes = Buffer.byteLength(read(P.agentsMdPath()) || '', 'utf8');
  const budget = CT.chainBudget(cfg, globalBytes, 0);
  add(
    'discovery-chain headroom for project docs',
    budget.headroom >= 0,
    budget.headroom >= 0
      ? `global AGENTS.md ${globalBytes}B / cap ${budget.cap}B — ${budget.headroom}B left for project chains`
      : `global AGENTS.md ${globalBytes}B EXCEEDS cap ${budget.cap}B by ${-budget.headroom}B — raise project_doc_max_bytes in config.toml`
  );

  return { ok: checks.every((c) => c.ok), checks };
}

if (require.main === module) {
  const parsed = parseNoArgs(
    process.argv.slice(2),
    'agentsmd doctor',
    'Run agentsmd install health checks: dependencies, native hooks, spec freshness, and discovery-chain headroom.'
  );
  if (parsed.help) {
    console.log(parsed.usage);
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd doctor: ${parsed.error}`);
    console.error(parsed.usage);
    process.exit(2);
  }
  const r = doctor();
  for (const c of r.checks) console.log(`${c.ok ? '  ok  ' : '  FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(r.ok ? '\nagentsmd doctor: all checks passed' : '\nagentsmd doctor: some checks failed');
  process.exit(r.ok ? 0 : 1);
}
module.exports = { doctor };
