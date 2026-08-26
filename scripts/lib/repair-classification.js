'use strict';

// Convert already-gathered repair evidence into a classification and operator
// action. This module performs no filesystem inspection or mutation and returns
// a new blocker array so plan collection remains independently reviewable.
function classifyRepairEvidence({
  manifestState,
  source,
  missing,
  mismatched,
  unexpected,
  blockers,
  standaloneFootprintPresent = false,
}) {
  const nextBlockers = [...blockers];
  let classification;
  let applyAllowed = false;
  let recommendedAction;

  if (!manifestState.present) {
    const footprintUnprovable = nextBlockers.length > 0 || standaloneFootprintPresent;
    classification = footprintUnprovable ? 'ownership-unprovable' : 'not-installed';
    if (footprintUnprovable) {
      nextBlockers.push('manifest is missing while an agentsmd runtime/shared footprint remains');
      recommendedAction = {
        code: 'inspect-manually',
        command: 'agentsmd repair --plan',
        reason: 'automatic repair cannot prove ownership without a valid manifest',
      };
    } else {
      recommendedAction = {
        code: 'install',
        command: 'agentsmd install',
        reason: 'no active standalone install was found',
      };
    }
  } else if (!manifestState.valid) {
    classification = 'ownership-unprovable';
    nextBlockers.push(manifestState.error || 'manifest is invalid');
    recommendedAction = {
      code: 'inspect-manually',
      command: 'agentsmd repair --plan',
      reason: 'automatic repair cannot prove ownership from this manifest',
    };
  } else {
    const manifest = manifestState.manifest;
    if (nextBlockers.length) classification = 'ownership-unprovable';
    else if (mismatched.length || unexpected.length) classification = 'owned-content-modified';
    else if (missing.length) {
      const matchingArtifact = manifest.version === source.version
        && manifest.ownedArtifacts.deploy.sha256 === source.deploySha256;
      if (matchingArtifact) {
        classification = 'owned-files-missing';
        applyAllowed = true;
      } else classification = 'matching-artifact-required';
    } else if (manifest.version !== source.version
        || manifest.ownedArtifacts.deploy.sha256 !== source.deploySha256) {
      classification = 'update-ready';
    } else classification = 'healthy';

    if (applyAllowed) {
      recommendedAction = {
        code: 'confirm-repair',
        command: 'agentsmd repair --confirm=<planDigest>',
        reason: 'valid ownership exists and only manifest-recorded files or directories are missing',
      };
    } else if (classification === 'healthy') {
      recommendedAction = {
        code: 'none',
        command: null,
        reason: 'standalone owned artifacts are intact and current',
      };
    } else if (classification === 'update-ready') {
      recommendedAction = {
        code: 'update',
        command: 'agentsmd update',
        reason: 'owned artifacts are intact and can use the ordinary update path',
      };
    } else if (classification === 'matching-artifact-required') {
      recommendedAction = {
        code: 'use-matching-artifact',
        command: `run agentsmd repair --plan from @sdsrs/agentsmd@${manifest.version}`,
        reason: 'repair replaces the complete release tree, so its source version and deploy digest must match the ownership manifest',
      };
    } else {
      recommendedAction = {
        code: 'inspect-manually',
        command: 'agentsmd repair --plan',
        reason: 'automatic repair will not overwrite modified, unexpected, unsafe, or unprovable content',
      };
    }
  }

  return { classification, applyAllowed, blockers: nextBlockers, recommendedAction };
}

module.exports = { classifyRepairEvidence };
