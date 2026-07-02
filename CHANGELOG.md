# Changelog

Release history for **agentsmd** (the Codex coding-spec enforcement plugin). The
spec's own rule-level history lives in `spec/AGENTS-CHANGELOG.md`.

## v2.0.0 — 2026-07-03 — renamed codexmd → agentsmd

**Breaking: the project, package, and plugin are renamed `codexmd` → `agentsmd`** to
match the GitHub repository (`sdsrss/agentsmd`). This is the same system published
previously as **codexmd v1.4.0–v1.4.3**, now under its permanent name. The
`CODEX-CODING-SPEC` that agentsmd deploys — its rules and title — is unchanged; only
the tool's own identity moved.

### Changed
- Plugin / package / install name is now `agentsmd`. Every agentsmd-owned path moved with
  it: the `/agentsmd/` marker in `~/.codex/hooks.json`, the `~/.codex/agentsmd/` install
  dir, `~/.codex/.agentsmd-state/`, `~/.codex/logs/agentsmd.jsonl`, the `# >>> agentsmd >>>`
  `AGENTS.md` sentinel, the `agentsmd-*` command skills, and the `DISABLE_AGENTSMD_HOOKS` /
  `AGENTSMD_LOG_MAX_MB` / `AGENTSMD_NO_TIMEOUT_BIN` env vars. Codex's own names (`~/.codex`,
  `CODEX_HOME`, `.codex-plugin/`, `config.toml`) are deliberately untouched.

### Migration (automatic — no manual step to upgrade)
- **Installing agentsmd cleans up a prior codexmd install for you.** The installer strips
  the legacy `/codexmd/` hooks, the `# >>> codexmd >>>` `AGENTS.md` block, the `codexmd-*`
  skills, and `~/.codex/{codexmd, .codexmd-state}` — marker-scoped, so oh-my-codex and every
  other tenant are left byte-for-byte. It is a no-op when no codexmd is present, and
  `uninstall` sweeps any codexmd remnant too (`scripts/lib/migrate.js`).

### Docs
- README rewritten (English) with a full Chinese translation (`README.zh-CN.md`) and a
  language switcher on both; GitHub description + topics added for discoverability.

## v1.4.3 — 2026-07-03 — Stop-advisory surfacing verified + resume fix

### Fixed
- `session-start-check.sh` cleared the pending-advisory queue on EVERY SessionStart,
  including `resume` — dropping an advisory that a resumed session's previous turn had
  queued, before `surface-advisories` could show it. It now clears only on a fresh
  start (SessionStart `source != "resume"`), so resumed sessions keep their queue.

### Verified
- The v1.4.1 deferred-surfacing mechanism is now **empirically confirmed against live
  Codex 0.142**: a Stop-hook advisory queued in turn 1 was surfaced at turn 2's
  `UserPromptSubmit` and **quoted back verbatim by the model** — the `additionalContext`
  channel reaches the model, closing the I5 open item. (Also confirmed the SessionStart
  stdin `.source` = `startup` / `resume` discriminator.)

## v1.4.2 — 2026-07-03 — Codex 0.142 hook-flag rename (codex_hooks → hooks)

### Changed
- Codex 0.142 renamed the hook feature flag `[features].codex_hooks` → `[features].hooks`
  (`codex_hooks` is deprecated). agentsmd now recognizes **both** names, sets the canonical
  `hooks` on install, and **migrates** a legacy `codex_hooks = true` to `hooks = true` in
  place (all other config byte-preserved). `doctor` / `status` accept either name.

### Note (unrelated to agentsmd, for anyone upgrading Codex)
- Codex 0.142 also dropped the legacy `profile = "..."` selector and `[profiles.*]` tables
  (each profile now lives in its own `~/.codex/<name>.config.toml`, selected with
  `--profile <name>`), and deprecated `[features].use_legacy_landlock`. Fix those in your
  own `~/.codex/config.toml` if Codex fails to start after upgrading.

## v1.4.1 — 2026-07-03 — Stop-advisory delivery fix

### Changed
- Stop-event advisories (`~/.codex/tmp` growth, undisposed scratch dirs, and the
  four-section / banned-vocab report scan) are now **queued at Stop and surfaced
  at the next UserPromptSubmit** via `additionalContext` — the surfacing channel
  oh-my-codex uses in production — instead of emitted inline on Stop, whose
  `additionalContext` surfacing is unverified. New `surface-advisories.sh`
  (UserPromptSubmit) drains the queue; `session-start-check.sh` clears it so
  advisories stay session-scoped. Hard enforcement (PreToolUse blocks) is
  unchanged.

### Note
- Empirical confirmation that the queued advisories reach the model still awaits
  an active Codex workspace (the dogfood account returned `402
  deactivated_workspace`), but delivery now rides the SessionStart/UserPromptSubmit
  channel rather than the unverified Stop channel. Telemetry remains the guaranteed
  record either way.

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
- **Command skills** (`skills/agentsmd-audit|rules|doctor|status`) and Codex
  plugin packaging (`.codex-plugin/plugin.json`, plugin-root `hooks.json`).

### Independence
- Touches only its own `/agentsmd/`-marked entries in the shared
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
