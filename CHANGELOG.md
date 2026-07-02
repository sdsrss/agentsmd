# Changelog

Release history for **codexmd** (the Codex coding-spec enforcement plugin). The
spec's own rule-level history lives in `spec/AGENTS-CHANGELOG.md`.

## v1.4.0 — 2026-07-03 — first release

A global coding-discipline spec for Codex, enforced by native Codex hooks and
kept honest by a rule-hit telemetry closed loop. Manages only its own entries in
`~/.codex` and stays independent of oh-my-codex.

### Added
- **Spec** (`spec/`): always-on core `AGENTS.md`, load-triggered
  `AGENTS-extended.md`, shared `AGENTS-CHANGELOG.md`, machine-readable
  `hard-rules.json` (29 rules + `live_sections`), and human-only `OPERATOR.md`.
- **9 native hooks** across SessionStart / PreToolUse / UserPromptSubmit / Stop:
  §8 SAFETY (blocks `rm -rf $VAR` and remote `curl | bash`), §10 banned-vocab on
  commits, §E3 red-CI ship gate, §7 MEMORY.md read gate + recall hint,
  four-section report scan, and residue / sandbox-disposal audits.
- **Management** (`scripts/`): marker-scoped install / uninstall, status, doctor,
  and `audit` / `rules` promote-demote governance over the telemetry log.
- **Command skills** (`skills/codexmd-audit|rules|doctor|status`) and Codex
  plugin packaging (`.codex-plugin/plugin.json`, plugin-root `hooks.json`).

### Independence
- Touches only its own `/codexmd/`-marked entries in the shared
  `~/.codex/hooks.json`, `config.toml` (`[features] codex_hooks`), `AGENTS.md`
  (sentinel block), and `~/.codex/skills/` — never other tenants'. Installs with
  or without oh-my-codex present. Honors `$CODEX_HOME`.

### Testing
- 85 automated checks (install/independence, closed-loop telemetry, drift,
  hook smoke) plus a 19-check end-to-end install simulation.

### Fixed (pre-release review round)
- Refuse to overwrite an unparseable `~/.codex/hooks.json` (previously dropped
  other tenants' hooks silently).
- `rm -rf $VAR` detection now covers long flags (`--recursive` / `--force`) and
  path-qualified `/bin/rm`.
- `config.toml codex_hooks` detection is `[features]`-scoped — a stray key under
  another table no longer reads as enabled.
- SessionStart refreshes the sandbox-disposal reference (was frozen at the first
  Stop).
- Test suite pins `$CODEX_HOME` to the sandbox (no telemetry leakage).
- banned-vocab scans only the `-m` message; the ship gate resolves `src:dst`
  push refspecs.

### Known limitations
- Stop-event `additionalContext` surfacing (four-section report advisory) is
  pending live-Codex verification; the telemetry log is the reliable channel
  until then.
