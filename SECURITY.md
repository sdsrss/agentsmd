# Security policy

## Reporting a vulnerability

- **Preferred**: GitHub private vulnerability reporting on [`sdsrss/agentsmd`](https://github.com/sdsrss/agentsmd/security/advisories/new).
- **Alternative**: email `sammuaicode@gmail.com` with subject `agentsmd security`.
- Please do not open public issues for suspected vulnerabilities before a fix is available.

**Response targets** (solo-maintained project; best-effort but tracked): acknowledgement within 7 days, triage verdict within 14 days, fix or documented mitigation for confirmed vulnerabilities within 90 days. If a report is declined, you get the reasoning in writing.

## Supported versions

Only the **latest published minor of the 4.x line** receives security fixes (the project ships forward-only minors; there are no maintenance branches). Check the current version with `npm view @sdsrs/agentsmd dist-tags.latest` or `agentsmd status`. Older versions: upgrade via `npm i -g @sdsrs/agentsmd && agentsmd update`.

## What agentsmd is — and is not

agentsmd is a **fail-open coding-discipline layer**, not a security boundary:

- Hooks block a few mechanically detectable hazards (`rm -rf $VAR`, secret-shaped commits, remote-download-then-execute, red-CI pushes) and observe others, but **any hook failure fails open** so a broken hook can never lock the user out of their own shell. A malicious or determined agent/user can bypass hooks (kill switches are documented below by design).
- Do **not** rely on agentsmd to prevent data exfiltration, enforce sandboxing, or contain a compromised model or plugin. Codex's own sandbox/approval settings remain the security mechanism.

## Threat model (summary)

| Surface | Trust boundary |
|---|---|
| Install | Network access only at install time: the bootstrap resolves an immutable GitHub release tag and verifies the published SHA-256 **before executing anything**; mutable refs are refused without an explicit `--dev` flag. npm installs are version-pinned by the user's lockfile/choice. |
| Runtime hooks | Local `bash` running as the invoking user on Codex events. No network egress at runtime. Fail-open; kill switches: `DISABLE_AGENTSMD_HOOKS=1` (all), `DISABLE_<NAME>_HOOK=1` (one). |
| Shared config (`~/.codex/hooks.json`, `config.toml`, `AGENTS.md`) | agentsmd edits only its own sentinel-marked / path-matched entries; an unparseable shared file aborts the install rather than clobbering other tenants. Lifecycle operations are lock-serialized and journaled with automatic crash recovery. |
| Project tools (`init`/`analyze`/`design`) | Read the current project only; symlinks that escape the project root are never followed; writes are sentinel-scoped and preview-by-default where applicable. |

## Telemetry: schema, retention, deletion, opt-out

Telemetry is **local-only** — nothing is transmitted anywhere. Rows are appended to `$CODEX_HOME/logs/agentsmd.jsonl` (default `~/.codex/logs/agentsmd.jsonl`), created private (`umask 077` → `0600`/`0700`; install tightens pre-existing wide modes; `doctor` checks it).

- **Schema per row**: `ts`, `hook`, `event` (block/advisory/observe/bypass/fail-open/…), `project` (the working-directory **path slug** — the only potentially personal field, and why the file is private), `session_id`, `spec_section`, `eligible`/`evaluated` (opportunity booleans), small structured `extra` (e.g. a pattern id), optional `tag` (`test`/`qa` rows are excluded from governance analytics). Command lines, file contents, and secrets are **not** recorded.
- **Retention**: size-capped rotation — at `AGENTSMD_LOG_MAX_MB` (default 5 MB) the log rotates to `.1`/`.2`; at most three generations (~15 MB) exist. No time-based retention.
- **Deletion**: `rm ~/.codex/logs/agentsmd.jsonl*`. Note `agentsmd uninstall` removes hooks/spec/skills but deliberately leaves the log (it is the user's data); delete it manually if desired.
- **Opt-out**: `DISABLE_RULE_HITS_LOG=1` disables telemetry while keeping enforcement; the kill switches above disable hooks entirely.
- **Consumers**: only the local `agentsmd audit` / `agentsmd rules` CLIs read it, for the operator's own promote/demote review.

## Known operational caveats

- **Dual-surface skills duplication**: surface arbitration makes hooks/context injection exactly-once when both the plugin and a standalone install are present, but Codex loads *skills* outside that arbitration — both copies' skills enter the session (prompt bloat, no security impact). Install only one surface; `doctor` flags dual-surface state.
- Structured per-repo §8 exceptions (`.agentsmd/exceptions.json`) are fingerprint-scoped and expire; every use is telemetried. They are reviewable waivers, not silent bypasses.
