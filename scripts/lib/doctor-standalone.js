'use strict';

// Pure mapping of collected standalone configuration and registration evidence.
// File reads and install-path ownership classification stay in doctor.js.
const CT = require('./config-toml');
const REG = require('./hook-registry');

function inspectStandaloneConfiguration({
  surfaceStatus,
  cfg,
  hooksParseable,
  registeredHooks,
  manifestRaw,
}) {
  const checks = [];
  const add = (name, ok, detail) =>
    checks.push({ name, ok, detail: detail || '' });
  const arbitration = surfaceStatus.surfaceArbitration;
  const pluginBundle = arbitration.candidates.plugin;
  add(
    'surface arbitration selected a healthy candidate',
    arbitration.selection.selected === 'standalone' &&
      arbitration.candidates.standalone.healthy,
    arbitration.selection.selected
      ? `selected=${arbitration.selection.selected}; reason=${arbitration.selection.reasonCode}`
      : `selected=none; reason=${arbitration.selection.reasonCode}`
  );
  if (pluginBundle.detected) {
    add(
      'dual surface absent',
      !surfaceStatus.dualSurface,
      surfaceStatus.dualSurface
        ? `dualSurface=true — standalone wins (${arbitration.selection.reasonCode}); plugin hooks must yield, but remove one delivery surface to eliminate configuration ambiguity`
        : 'dualSurface=false'
    );
  }

  const standaloneConfig = arbitration.candidates.standalone.config;
  add(
    'config.toml accepted by Codex parser',
    standaloneConfig.parseable,
    standaloneConfig.parseable
      ? standaloneConfig.validator
      : standaloneConfig.errorCode === 'codex-cli-unavailable'
        ? 'surface health unverifiable (codex CLI not found — install codex or set AGENTSMD_CODEX_BIN)'
        : standaloneConfig.errorCode
  );
  add(
    'config.toml features.hooks=true',
    standaloneConfig.hooksEnabled,
    'Codex native hooks enabled ([features] hooks; legacy codex_hooks also recognized)'
  );
  const statusLine = CT.getTuiStatusLine(cfg);
  const statusLineOk = statusLine.exists && statusLine.items !== null;
  add(
    'config.toml tui.status_line configured',
    statusLineOk,
    CT.isAgentsmdStatusLineEnabled(cfg)
      ? 'agentsmd preset'
      : statusLine.exists
        ? statusLineOk
          ? 'custom'
          : 'unparseable'
        : 'missing'
  );

  // Expected hook count comes from the hook-registry (single source of truth);
  // hook-registry.test.js asserts the registry never drifts from either hooks.json
  // wiring, so this stays equivalent to the old template-parse without re-reading it.
  const expectedHooks = REG.HOOK_REGISTRY.length;
  // hooks.json parseable? countAgentsmdHooks returns 0 on an UNPARSEABLE file exactly
  // as it does for "no agentsmd hooks" — but an unparseable SHARED hooks.json is a
  // distinct, worse state: install AND uninstall both abort on it (they refuse to
  // clobber a file that may hold other tenants' hooks), so every management command
  // is wedged until it's fixed. Surface it instead of hiding it behind a bare 0/15.
  add(
    'hooks.json parseable',
    hooksParseable,
    hooksParseable
      ? 'ok'
      : 'UNPARSEABLE — install/uninstall abort on this; fix or remove ~/.codex/hooks.json'
  );
  const manifestInstalled = manifestRaw !== null;
  let manifest = null;
  try {
    manifest = manifestRaw === null ? null : JSON.parse(manifestRaw);
  } catch {}
  add(
    'agentsmd hooks registered',
    hooksParseable && registeredHooks === expectedHooks,
    hooksParseable
      ? `${registeredHooks}/${expectedHooks}`
      : `unknown — hooks.json unparseable`
  );
  // Install-state consistency: install writes the manifest LAST, so hooks live in the
  // shared hooks.json with NO manifest means a crash between the hooks-merge and the
  // manifest-write (or a manually-removed state dir). status.installed reads false off
  // the manifest while the hooks actually run — a contradiction doctor must name, not
  // report as two unrelated lines ("15/15 ok" + "not installed").
  add(
    'install state consistent (manifest vs live hooks)',
    !(!manifestInstalled && registeredHooks > 0),
    !manifestInstalled && registeredHooks > 0
      ? `partial install — ${registeredHooks} hooks live in hooks.json but no manifest (crash mid-install or state dir removed) — run agentsmd repair --plan; automatic apply requires valid ownership evidence`
      : 'ok'
  );

  return { checks, manifestInstalled, manifest };
}

module.exports = { inspectStandaloneConfiguration };
