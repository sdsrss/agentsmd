'use strict';
// hook-registry.js — the single source of truth for agentsmd's native Codex
// hooks: one row per hook, in Codex execution order (SessionStart → PreToolUse →
// UserPromptSubmit → Stop). Ported in spirit from claudemd/scripts/lib/hook-registry.js.
//
// Why this exists: the hook list + kill-switch suffixes were previously implicit,
// duplicated across the two hooks.json wirings and 15 `hook_kill_switch "<NAME>"`
// calls, with status/doctor re-deriving counts by parsing the template. This
// centralizes them so L2 (status/doctor) reads ONE list and hook-registry.test.js
// asserts the registry, both wirings, and each hook's own kill-switch call never
// drift. L1 hooks (bash) do NOT import this — the L1→L2 isolation invariant holds;
// this is consumed by L2 scripts + tests only.
//
// Kill switch for a hook = env var `DISABLE_${envVarSuffix}_HOOK` == "1" (or the
// global `DISABLE_AGENTSMD_HOOKS` == "1"), matching hook-common.sh hook_kill_switch.
// matcher is null for events wired without one (UserPromptSubmit / Stop).

const HOOK_REGISTRY = [
  { basename: 'session-start-check.sh',       displayName: 'session-start-check',       envVarSuffix: 'SESSION_START',           hookEvent: 'SessionStart',     matcher: 'startup|resume', timeout: 5 },

  { basename: 'pre-bash-safety-check.sh',     displayName: 'pre-bash-safety-check',     envVarSuffix: 'PRE_BASH_SAFETY',         hookEvent: 'PreToolUse',       matcher: 'Bash',           timeout: 3 },
  { basename: 'banned-vocab-check.sh',        displayName: 'banned-vocab-check',        envVarSuffix: 'BANNED_VOCAB',            hookEvent: 'PreToolUse',       matcher: 'Bash',           timeout: 3 },
  { basename: 'ship-baseline-check.sh',       displayName: 'ship-baseline-check',       envVarSuffix: 'SHIP_BASELINE',           hookEvent: 'PreToolUse',       matcher: 'Bash',           timeout: 8 },
  { basename: 'memory-read-check.sh',         displayName: 'memory-read-check',         envVarSuffix: 'MEMORY_READ',             hookEvent: 'PreToolUse',       matcher: 'Bash',           timeout: 3 },
  { basename: 'secrets-scan.sh',              displayName: 'secrets-scan',              envVarSuffix: 'SECRETS_SCAN',            hookEvent: 'PreToolUse',       matcher: 'Bash',           timeout: 5 },

  { basename: 'surface-advisories.sh',        displayName: 'surface-advisories',        envVarSuffix: 'SURFACE_ADVISORIES',      hookEvent: 'UserPromptSubmit', matcher: null,             timeout: 3 },
  { basename: 'memory-prompt-hint.sh',        displayName: 'memory-prompt-hint',        envVarSuffix: 'MEMORY_PROMPT_HINT',      hookEvent: 'UserPromptSubmit', matcher: null,             timeout: 3 },

  { basename: 'residue-audit.sh',             displayName: 'residue-audit',             envVarSuffix: 'RESIDUE_AUDIT',           hookEvent: 'Stop',             matcher: null,             timeout: 3 },
  { basename: 'sandbox-disposal-check.sh',    displayName: 'sandbox-disposal-check',    envVarSuffix: 'SANDBOX_DISPOSAL',        hookEvent: 'Stop',             matcher: null,             timeout: 3 },
  { basename: 'transcript-structure-scan.sh', displayName: 'transcript-structure-scan', envVarSuffix: 'TRANSCRIPT_STRUCTURE',    hookEvent: 'Stop',             matcher: null,             timeout: 5 },
  { basename: 'convention-cite-scan.sh',      displayName: 'convention-cite-scan',      envVarSuffix: 'CONVENTION_CITE',         hookEvent: 'Stop',             matcher: null,             timeout: 5 },
  { basename: 'session-exit-checkpoint.sh',   displayName: 'session-exit-checkpoint',   envVarSuffix: 'SESSION_EXIT_CHECKPOINT', hookEvent: 'Stop',             matcher: null,             timeout: 5 },
  { basename: 'mem-audit.sh',                 displayName: 'mem-audit',                 envVarSuffix: 'MEM_AUDIT',               hookEvent: 'Stop',             matcher: null,             timeout: 5 },
  { basename: 'session-summary.sh',           displayName: 'session-summary',           envVarSuffix: 'SESSION_SUMMARY',         hookEvent: 'Stop',             matcher: null,             timeout: 5 },
];

const HOOK_BASENAMES = HOOK_REGISTRY.map((h) => h.basename);
const HOOK_ENV_SUFFIXES = HOOK_REGISTRY.map((h) => h.envVarSuffix);
const HOOK_NAME_TO_ENV = Object.fromEntries(HOOK_REGISTRY.map((h) => [h.displayName, h.envVarSuffix]));

// Which hooks are currently switched off, mirroring hook-common.sh hook_kill_switch
// (global DISABLE_AGENTSMD_HOOKS==1 → all off; else per-hook DISABLE_<SUFFIX>_HOOK==1).
function killSwitchState(env = process.env) {
  const global = env.DISABLE_AGENTSMD_HOOKS === '1';
  const disabled = HOOK_REGISTRY
    .filter((h) => global || env[`DISABLE_${h.envVarSuffix}_HOOK`] === '1')
    .map((h) => h.displayName);
  return { global, disabled };
}

module.exports = { HOOK_REGISTRY, HOOK_BASENAMES, HOOK_ENV_SUFFIXES, HOOK_NAME_TO_ENV, killSwitchState };
