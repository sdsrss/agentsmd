'use strict';
// doctor.js — health checks for an agentsmd install + spec integrity.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const P = require('./lib/paths');
const CT = require('./lib/config-toml');
const H = require('./lib/codex-hooks');
const REG = require('./lib/hook-registry');
const { parseNoArgs } = require('./status');

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
  const registeredHooks = H.countAgentsmdHooks(read(P.hooksJsonPath()) || '');
  add(
    'agentsmd hooks registered',
    registeredHooks === expectedHooks,
    `${registeredHooks}/${expectedHooks}`
  );

  const hooksDir = P.installHooksDir();
  if (fs.existsSync(hooksDir)) {
    let execOk = true, bad = '';
    for (const f of fs.readdirSync(hooksDir)) if (f.endsWith('.sh')) {
      try { fs.accessSync(path.join(hooksDir, f), fs.constants.X_OK); } catch { execOk = false; bad = f; }
    }
    add('installed hooks executable', execOk, execOk ? 'ok' : `not executable: ${bad}`);
  } else {
    add('installed hooks executable', false, 'not installed');
  }

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
  const parsed = parseNoArgs(process.argv.slice(2), 'agentsmd-doctor');
  if (parsed.help) {
    console.log('Usage: agentsmd-doctor');
    process.exit(0);
  }
  if (parsed.error) {
    console.error(`agentsmd doctor: ${parsed.error}`);
    console.error('Usage: agentsmd-doctor');
    process.exit(1);
  }
  const r = doctor();
  for (const c of r.checks) console.log(`${c.ok ? '  ok  ' : '  FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(r.ok ? '\nagentsmd doctor: all checks passed' : '\nagentsmd doctor: some checks failed');
  process.exit(r.ok ? 0 : 1);
}
module.exports = { doctor };
