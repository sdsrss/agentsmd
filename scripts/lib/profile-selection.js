'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const F = require('./fs-atomic');
const AM = require('./agents-md');

const OMX_MARKER = '<!-- omx:generated:agents-md -->';
const PROFILE_MODES = ['legacy-full', 'auto', 'full', 'omx-compatible'];

function validateRequestedProfile(profile) {
  if (profile === undefined || profile === null) return null;
  if (!PROFILE_MODES.includes(profile) || profile === 'legacy-full') {
    throw new Error(`profile must be one of: auto, full, omx-compatible`);
  }
  return profile;
}

function activeGlobalGuidance() {
  const override = path.join(P.codexHome(), 'AGENTS.override.md');
  const selectedPath = F.pathExists(override) ? override : P.agentsMdPath();
  let content;
  try {
    const stat = fs.statSync(selectedPath);
    if (!stat.isFile()) {
      return { path: selectedPath, state: 'unknown', reason: 'active-global-not-regular' };
    }
    content = fs.readFileSync(selectedPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { path: selectedPath, state: 'absent', reason: 'no-active-global-marker' };
    }
    return { path: selectedPath, state: 'unknown', reason: 'active-global-unreadable' };
  }

  // The OMX-compatible agentsmd core documents the exact marker text. For the
  // managed global AGENTS.md path, inspect only the surrounding tenant/user
  // guidance so our own materialized block cannot manufacture OMX activation.
  const evidence = selectedPath === P.agentsMdPath()
    ? AM.removeSpecBlock(content).content
    : content;
  return evidence.includes(OMX_MARKER)
    ? { path: selectedPath, state: 'present', reason: 'active-global-marker' }
    : { path: selectedPath, state: 'absent', reason: 'no-active-global-marker' };
}

function selectedProfile(mode, evidence) {
  if (mode === 'legacy-full') {
    return { selectionMode: mode, materialized: 'full', reason: 'v1-upgrade-preservation' };
  }
  if (mode === 'full') {
    return { selectionMode: mode, materialized: 'full', reason: 'explicit-full' };
  }
  if (mode === 'omx-compatible') {
    if (evidence.state !== 'present') {
      throw new Error(
        `OMX-compatible profile requires the exact active ${OMX_MARKER} marker; `
        + `use --profile=full or --profile=auto`
      );
    }
    return { selectionMode: mode, materialized: 'omx-compatible', reason: 'active-global-marker' };
  }
  return evidence.state === 'present'
    ? { selectionMode: 'auto', materialized: 'omx-compatible', reason: 'active-global-marker' }
    : {
      selectionMode: 'auto',
      materialized: 'full',
      reason: evidence.state === 'unknown'
        ? 'omx-detection-unknown-fallback'
        : 'no-active-global-marker',
    };
}

function resolveInstallProfile(requested, priorManifest, options = {}) {
  const explicit = validateRequestedProfile(requested);
  const priorMode = priorManifest
    && priorManifest.manifestSchemaVersion === 2
    && priorManifest.profile
    && PROFILE_MODES.includes(priorManifest.profile.selectionMode)
    ? priorManifest.profile.selectionMode
    : null;
  if (options.preserveMaterialized === true && !explicit && priorMode) {
    return {
      selectionMode: priorManifest.profile.selectionMode,
      materialized: priorManifest.profile.materialized,
      reason: priorManifest.profile.reason,
    };
  }
  const mode = explicit || priorMode || 'legacy-full';
  return selectedProfile(mode, activeGlobalGuidance());
}

function describeProfileState(manifest) {
  if (!manifest || !manifest.profile) {
    return {
      desiredProfile: manifest ? 'full' : null,
      desiredProfileReason: manifest ? 'implicit-schema-1' : null,
      profileState: manifest ? 'aligned' : null,
      omxDetection: manifest ? activeGlobalGuidance().state : null,
    };
  }
  const evidence = activeGlobalGuidance();
  let desired = 'full';
  let reason = evidence.reason;
  if (manifest.profile.selectionMode === 'full') {
    desired = 'full';
    reason = 'explicit-full';
  } else if (evidence.state === 'present') {
    desired = 'omx-compatible';
  }
  return {
    desiredProfile: desired,
    desiredProfileReason: reason,
    profileState: desired === manifest.profile.materialized ? 'aligned' : 'drift',
    omxDetection: evidence.state,
  };
}

module.exports = {
  OMX_MARKER,
  PROFILE_MODES,
  activeGlobalGuidance,
  describeProfileState,
  resolveInstallProfile,
  validateRequestedProfile,
};
