---
name: codexmd-doctor
description: Health-check a codexmd install (jq/node present, the [features] hooks flag enabled, hooks executable, hard-rules anchors resolve). Use when codexmd hooks seem not to fire, after installing/updating codexmd, when the user asks to diagnose or verify the codexmd setup, or to check spec↔manifest drift. Read-only diagnostics.
---

# codexmd-doctor

Run codexmd's health checks and report which pass/fail.

```bash
node "${CODEX_HOME:-$HOME/.codex}/codexmd/scripts/doctor.js"
```

Checks: `jq` + `node` on PATH, `config.toml features.hooks=true` (Codex 0.142+; legacy `codex_hooks` also recognized — else native hooks are off), installed hooks executable, and every `hard-rules.json` `section_anchor` still resolves in the spec (drift guard). A red hooks flag means the hooks are registered but Codex is not running them — enable the feature. A red anchor means the spec text moved without updating `hard-rules.json`.
