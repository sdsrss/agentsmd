---
name: agentsmd-status
description: Show agentsmd install state (安装状态清单), registered hooks, preserved tenants, config flags, and telemetry rows. Use for a quick inventory. Not for health diagnosis or rule analysis.
---

# agentsmd-status

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

Report agentsmd's install footprint and confirm clean coexistence with any other tenant.

```bash
agentsmd_skill_run
```

For a plugin invocation, `pluginBundle.complete` confirms the selected manifest, 19 ordered hook registrations and scripts, and both spec files. Runtime `PLUGIN_ROOT` is preferred, `CLAUDE_PLUGIN_ROOT` remains the runtime compatibility alias, and `AGENTSMD_PLUGIN_ROOT` remains the skill-resolved compatibility path; conflicting roots fail health closed. Never scan plugin caches because presence does not prove activation. `pluginActivation.state` is separate: `observed` proves only that a selected plugin SessionStart handler prepared the recorded profile for its response, while `unverified` means no valid receipt is visible in the current plugin-data context. It does not prove that Codex accepted the response, or that every hook was trusted or executed. `installed` and the existing standalone fields retain their standalone meaning, including `agentsmdHooksRegistered` (should be 19); legacy `dualSurface` retains manifest-presence semantics. `surfaceArbitration` reports partial footprints, candidate evidence, `selection.selected`, a stable reason code, and whether the static cooperation protocol supports exclusive execution; this is not runtime exact-once proof. `sessionSummaries` exposes stored operator telemetry without injecting stale state into a new session. When plugin wins over a legacy standalone, explain that its global core and already-registered hooks may continue until update/uninstall. If a standalone manifest is malformed or unreadable, diagnose it before any lifecycle action; do not recommend a blind reinstall.
