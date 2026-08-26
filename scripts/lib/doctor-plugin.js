'use strict';

// Map an already-inspected surface status to the plugin-selected doctor rows.
// This phase is deliberately side-effect free: status owns discovery and I/O,
// while doctor owns prerequisite rows and the final aggregate health verdict.
function inspectSelectedPluginSurface(surfaceStatus) {
  const arbitration = surfaceStatus.surfaceArbitration;
  const pluginBundle = arbitration.candidates.plugin;
  if (!pluginBundle.detected || arbitration.selection.selected === 'standalone') return null;

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });
  const dualSurface = surfaceStatus.dualSurface;
  const standaloneCandidate = arbitration.candidates.standalone;
  const pluginActivation = surfaceStatus.pluginActivation;

  add(
    'plugin manifest selects ./hooks.json',
    pluginBundle.manifest.valid,
    pluginBundle.manifest.valid
      ? './hooks.json'
      : (pluginBundle.manifest.hooksPath || pluginBundle.errors[0] || 'missing')
  );
  add(
    'plugin hooks registered',
    pluginBundle.hooks.valid,
    `${pluginBundle.hooks.registered}/${pluginBundle.hooks.expected}`
  );
  add(
    'plugin hook scripts present',
    pluginBundle.hooks.missingScripts.length === 0,
    pluginBundle.hooks.missingScripts.length
      ? `missing: ${pluginBundle.hooks.missingScripts.join(', ')}`
      : `${pluginBundle.hooks.expected}/${pluginBundle.hooks.expected}`
  );
  add(
    'plugin hook support present',
    pluginBundle.hooks.missingSupport.length === 0,
    pluginBundle.hooks.missingSupport.length
      ? `missing: ${pluginBundle.hooks.missingSupport.join(', ')}`
      : '9/9'
  );
  add(
    'plugin core spec present',
    pluginBundle.spec.core,
    pluginBundle.spec.core ? 'spec/AGENTS.md' : 'missing spec/AGENTS.md'
  );
  add(
    'plugin extended spec present',
    pluginBundle.spec.extended,
    pluginBundle.spec.extended ? 'spec/AGENTS-extended.md' : 'missing spec/AGENTS-extended.md'
  );
  add(
    'plugin SessionStart activation',
    true,
    pluginActivation.observed
      ? `observed at ${pluginActivation.receipt.observedAt}; session=${pluginActivation.receipt.sessionId}; profile=${pluginActivation.receipt.profile}; reason=${pluginActivation.receipt.profileReason}; extended=${pluginActivation.receipt.extendedPath}; this proves the SessionStart handler reached profile preparation only, not that Codex accepted the response or that every plugin hook was trusted or executed`
      : `unverified (${pluginActivation.reason}) — no SessionStart receipt was observed; review the agentsmd hooks, then start a new session`
  );
  add(
    'dual surface absent',
    !dualSurface,
    dualSurface
      ? `dualSurface=true — selected plugin (${arbitration.selection.reasonCode}), but a standalone manifest remains; run agentsmd update with the matching standalone artifact or uninstall one surface`
      : 'dualSurface=false'
  );
  add(
    'surface arbitration selected a healthy candidate',
    arbitration.selection.selected === 'plugin' && pluginBundle.healthy,
    arbitration.selection.selected
      ? `selected=${arbitration.selection.selected}; reason=${arbitration.selection.reasonCode}`
      : `selected=none; reason=${arbitration.selection.reasonCode}`
  );
  add(
    'surface arbitration has no non-cooperative loser',
    arbitration.selection.exclusive,
    arbitration.selection.exclusive
      ? 'static protocol condition satisfied; runtime exact-once remains an end-to-end gate'
      : 'legacy/non-cooperative standalone hooks may still execute until that surface is updated or removed'
  );
  if (standaloneCandidate.detected) {
    add(
      'standalone candidate healthy',
      standaloneCandidate.healthy,
      standaloneCandidate.healthy
        ? `v${standaloneCandidate.version}`
        : standaloneCandidate.reasons.slice(0, 3).join('; ')
    );
  }

  return {
    surface: 'plugin',
    selectedSurface: arbitration.selection.selected,
    dualSurface,
    pluginActivation,
    surfaceArbitration: arbitration,
    checks,
  };
}

module.exports = { inspectSelectedPluginSurface };
