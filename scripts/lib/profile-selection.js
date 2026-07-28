'use strict';

const PROFILE_MODES = ['full'];

function validateRequestedProfile(profile) {
  if (profile === undefined || profile === null) return null;
  if (!PROFILE_MODES.includes(profile)) {
    throw new Error('profile must be full; compatibility profiles were removed');
  }
  return profile;
}

function resolveInstallProfile(requested) {
  const explicit = validateRequestedProfile(requested);
  return {
    selectionMode: 'full',
    materialized: 'full',
    reason: explicit ? 'explicit-full' : 'single-full-profile',
  };
}

function describeProfileState(manifest) {
  if (!manifest) {
    return {
      desiredProfile: null,
      desiredProfileReason: null,
      profileState: null,
    };
  }
  const materialized = manifest.profile ? manifest.profile.materialized : 'full';
  return {
    desiredProfile: 'full',
    desiredProfileReason: 'single-full-profile',
    profileState: materialized === 'full' ? 'aligned' : 'drift',
  };
}

module.exports = {
  PROFILE_MODES,
  describeProfileState,
  resolveInstallProfile,
  validateRequestedProfile,
};
