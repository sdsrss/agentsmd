---
name: agentsmd-status
description: Show agentsmd install state (安装状态清单), registered hooks, preserved tenants, config flags, and telemetry rows. Use for a quick inventory. Not for health diagnosis or rule analysis.
---

# agentsmd-status

Resolve the script root first. Set `SKILL_MD` to the selected SKILL.md absolute path from the live skills list; never infer it from the process cwd.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
CANDIDATE_ROOT="$(cd "$(dirname "$SKILL_MD")/../.." && pwd)"
if [ -f "$CANDIDATE_ROOT/scripts/status.js" ]; then
  AGENTSMD_ROOT="$CANDIDATE_ROOT"
  if [ -f "$CANDIDATE_ROOT/.codex-plugin/plugin.json" ]; then export AGENTSMD_PLUGIN_ROOT="$CANDIDATE_ROOT"; else unset AGENTSMD_PLUGIN_ROOT; fi
else
  AGENTSMD_ROOT="${CODEX_HOME:-$HOME/.codex}/agentsmd"
  unset AGENTSMD_PLUGIN_ROOT
fi
```

Report agentsmd's install footprint and confirm clean coexistence with any other tenant.

```bash
node "$AGENTSMD_ROOT/scripts/status.js"
```

For a plugin invocation, `pluginBundle.complete` confirms the selected manifest, 15 ordered hook registrations and scripts, and both spec files. Runtime `CLAUDE_PLUGIN_ROOT` is discovered directly; `AGENTSMD_PLUGIN_ROOT` remains the skill-resolved compatibility path. Never scan plugin caches because presence does not prove activation. `installed` and the existing standalone fields retain their standalone meaning, including `agentsmdHooksRegistered` (should be 15); legacy `dualSurface` retains manifest-presence semantics. `surfaceArbitration` reports partial footprints, candidate evidence, `selection.selected`, a stable reason code, and whether the static cooperation protocol supports exclusive execution; this is not runtime exact-once proof. `sessionSummaries` exposes stored operator telemetry without injecting stale state into a new session. When plugin wins over a legacy standalone, explain that its global core and already-registered hooks may continue until update/uninstall. If a standalone manifest is malformed or unreadable, diagnose it before any lifecycle action; do not recommend a blind reinstall.
