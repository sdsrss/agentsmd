---
name: agentsmd-doctor
description: Health-check a agentsmd install (jq/node present, the [features] hooks flag enabled, hooks executable, hard-rules anchors resolve). Use when agentsmd hooks seem not to fire, after installing/updating agentsmd, when the user asks to diagnose or verify the agentsmd setup, or to check spec↔manifest drift. Read-only diagnostics.
---

# agentsmd-doctor

Run agentsmd's health checks and report which pass/fail.

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/doctor.js"
```

Checks: `jq` + `node` on PATH, `config.toml features.hooks=true` (Codex 0.142+; legacy `codex_hooks` also recognized — else native hooks are off), installed hooks executable, and every `hard-rules.json` `section_anchor` still resolves in the spec (drift guard). A red hooks flag means the hooks are registered but Codex is not running them — enable the feature. A red anchor means the spec text moved without updating `hard-rules.json`.
