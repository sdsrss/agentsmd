# Changelog

Release history for **agentsmd** (the Codex coding-spec enforcement plugin). The
spec's own rule-level history lives in `spec/AGENTS-CHANGELOG.md`.

## v2.0.2 — 2026-07-03 — install/update hardening (no rule-text changes)

QA cycling across realistic install, update, migration, doctor, and hook-execution paths
surfaced several edge cases in the management layer. No spec RULE text changed.

### Fixed
- **`doctor` now fails on broken or removed installs.** It verifies the registered
  agentsmd hook count against the current wiring and treats a missing installed hook dir as
  unhealthy, instead of reporting "all checks passed" after uninstall or after `hooks.json`
  lost agentsmd entries.
- **`config.toml` parsing recognizes `[features]` table headers with inline comments.**
  The installer no longer appends a duplicate `[features]` table when a user has
  `[features] # comment`; it inserts or updates `hooks = true` in place.
- **Updates remove stale agentsmd hooks from retired events.** Re-running the installer now
  strips agentsmd-owned entries across every event before appending the current wiring, so
  hooks removed since an older release cannot remain registered.
- **Hook ownership markers are exact.** agentsmd-owned hooks are identified by the active
  `CODEX_HOME/agentsmd` install dir, and legacy codexmd hooks by the old
  `CODEX_HOME/codexmd` install dir. This prevents removing unrelated hooks whose commands
  happen to live in a project directory named `agentsmd` or `codexmd`.
- **Manual install supports shell-special `CODEX_HOME` paths.** The hook template is parsed
  before placeholder replacement, and generated shell command paths are escaped for the
  double-quoted command context, so paths containing spaces, quotes, or `$` still install and
  execute correctly.
- Docs and hook-manifest descriptions now state the exact install-dir marker behavior.

### Testing
- 109 → 122 automated checks. New coverage exercises `doctor` broken-install reporting,
  commented `[features]` tables, stale hook cleanup, unrelated same-name project hooks,
  legacy codexmd migration precision, and shell-special `CODEX_HOME` execution.
- Manual E2E covered install/status/doctor, dangerous Bash hook blocking, audit/rules,
  uninstall, stale agentsmd/codexmd cleanup, same-name unrelated hook preservation, and
  shell-special `CODEX_HOME` paths.

## v2.0.1 — 2026-07-03 — post-release audit fixes (no rule-text changes)

A full-project audit surfaced a telemetry-loss gap on upgrade plus six spec↔implementation
drifts. No spec RULE text changed; `hard-rules.json` reclassifies one rule's enforcement to
match reality.

### Fixed
- **Telemetry survives the codexmd→agentsmd upgrade.** `install` now migrates a prior
  `~/.codex/logs/codexmd.jsonl` into `logs/agentsmd.jsonl` (append, one-shot) so the
  promote/demote window is not reset to zero on upgrade (`scripts/lib/migrate.js`
  `migrateLegacyTelemetry`). Previously the rename orphaned all prior rule-hit data.
- **`memory-read-check` no longer self-satisfies.** Its block message named "MEMORY.md";
  if Codex echoed that into the transcript, the next retry's own detection matched it and
  let the ship through. The message now names the containing directory instead.
- **`memory-prompt-hint` matches 中文 prompts.** Keyword extraction was English-only, so a
  Chinese prompt never matched a Chinese index trigger word. Added locale-independent CJK
  matching (forced C byte-mode + `grep -a`; a `[一-龥]` class silently matches nothing in
  the hook's non-interactive shell, which does not inherit an interactive UTF-8 locale).
- **Both memory hooks resolve the git root**, not just `$CWD`, so a ship command run from a
  subdirectory still finds the project `MEMORY.md`.
- **`ship-baseline` branch parsing** tolerates `=`-bearing push flags (`--force-with-lease=…`).
- **`banned-vocab.patterns`** now covers the §6 bugfix-anchor phrasings `看上去 ok` / `跑过了`
  / `没问题了` (hard-rules `§6-bugfix-anchor` already declared this pattern set as its surface).
  The English "it runs" is intentionally left to the self-enforced / advisory layer — a bare
  blocking regex false-blocks legitimate text like "when it runs out of memory".
- **`hard-rules.json`**: `§E3-ship-checklist` was mislabeled `enforcement: both` pointing at
  an orphan section (`§7-ship-baseline`) no hook emits — a perpetual `hook-planned` false
  signal. It is now `self` (the hook-enforced green+fresh gate is the sibling
  `§E3-ship-baseline`).
- **`rules.js`** reports `no-data` instead of `demote-candidate` for a live hook rule when
  the telemetry window is empty — an empty window is not evidence of dilution.
- **`install`** wipes its install dir before copying, so a hook removed since the last
  version cannot linger unregistered.
- Accuracy: `agentsmd-status` skill hook count 7 → 10; `session-start` version fallback
  `v1.4.3` → `unknown` (a hardcoded version silently goes stale); spec task-file example
  version neutralized; Discovery byte-budget note `~2/3` → `~3/4`; `ARCHITECTURE.md` phase
  table marked complete; `_doc` "future CI drift test" → present-tense.

### Testing
- 100 → 109 automated checks (install/independence 43→47, closed-loop 9→10, drift 6→8, hook
  smoke 42→44). New drift guards: no hook hardcodes a spec version, and the status skill's
  stated hook count matches the wiring. New coverage: telemetry migration, `rules.js`
  no-data signal, CJK prompt hint.

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
