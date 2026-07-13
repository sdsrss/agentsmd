# Changelog

Release history for **agentsmd** (the Codex coding-spec enforcement plugin). The
spec's own rule-level history lives in `spec/AGENTS-CHANGELOG.md`.

## v4.3.0 — 2026-07-13 — audit remediation: hot-path arbitration cache, symlink boundary, private telemetry

Remediates the highest-priority findings of the 2026-07-13 v4.2.0 audit
(N-01/N-02/N-03, H-06, M-02, plus the qa-* sandbox-residue lesson and spec gaps
G-1..G-4). Roadmap tasks R0-04, R0-06, R1-02, R1-04, R1-05, R5-06 and the
banner half of R0-03.

### Fixed

- Dual-surface hooks no longer spawn the full arbitration inspector in every
  hook process (N-01). Yield decisions now read a private (0600) arbitration
  cache that SessionStart, `status`, `doctor`, and the inspector CLI refresh on
  every full inspection; the cache is validated against schema, resolved plugin
  root, and a manifest freshness key, and ANY missing/stale/malformed cache
  keeps both surfaces running — enforcement never silently vanishes. The
  SessionStart inspector run is bounded at 3s and the inner Codex config probe
  at 2000ms (was 5000ms), so the 3s-budget pre-Bash §8 safety hook can no
  longer be killed by its own surface check under dual-surface states.
- Project scanners no longer follow symlinks (H-06): `analyze` and `design`
  walkers reject every symlink (file, directory, in-root alias) and
  additionally confine each candidate read to the realpath of the project
  root. An untrusted checkout can no longer route out-of-repo file contents
  into AI context or generated docs.
- A no-healthy-surface SessionStart no longer claims the spec was "selected"
  while the surface line reports `selected=none` (N-03); the banner now names
  the degraded state and points at `agentsmd doctor`.
- `codex-cli-unavailable` now renders as "surface health unverifiable (codex
  CLI not found — install codex or set AGENTSMD_CODEX_BIN)" in status/doctor
  instead of implying a broken config, `AGENTSMD_CODEX_BIN` overrides PATH
  resolution, and a bare `node scripts/status.js` explains on stderr why no
  plugin bundle is discoverable when the plugin-root env vars are unset (N-02).

### Added

- Telemetry and state artifacts are now private by construction (M-02): hooks
  set `umask 077` (new logs/state files 0600, dirs 0700), install/update
  tightens pre-existing wide-mode agentsmd-owned artifacts (the audited live
  log was 0664), and a new doctor check reports anything still
  group/other-accessible. The shared `logs/` directory mode itself is left to
  the platform.
- The npm test chain now snapshots and verifies the live `$CODEX_HOME`
  surfaces (`scripts/tests/live-guard.js`): any test that writes through the
  sandbox constraint fails the suite instead of leaving residue (lesson from
  the qa-* session refs found in the live state dir).
- Spec v4.3.0 (G-1..G-4, see `spec/AGENTS-CHANGELOG.md`): core §7 always-loaded
  Mid-SPINE turn-yield anchor; core §3 canonical-over-prose trust rule; core §7
  post-compaction re-read (new self-enforced manifest rule
  `§7-post-compaction`, 39 → 40 rules); core §10 anti-defensive-PARTIAL
  clause. Core stays under the 15 KiB gate (14,056 → ~14.8 KB).

### Quality

- Suite growth: hook smoke 282 → 293, install 195 → 197, plugin-surface
  28 → 32, analyze 54 → 59, design-tokens 15 → 16, design 14 → 15; drift,
  safety-coverage, repair, version gates green; ShellCheck clean. New smoke
  coverage proves the §8 pre-Bash guard still blocks under every cache-degraded
  dual-surface state and that permissions hold under a permissive caller umask.

Rollback consumers by pinning `npm install -g @sdsrs/agentsmd@4.2.0` and
running `agentsmd update`; source/plugin users select `v4.2.0` and reinstall.
Revert the v4.3.0 release commit for source rollback. Published npm versions
are immutable and can only be deprecated.

## v4.2.0 — 2026-07-14 — health-first surface arbitration and guarded repair

### Added

- Added health-first standalone/plugin arbitration with full SemVer precedence,
  stable reason codes, candidate evidence, and an explicit exclusivity result.
  `status` now reports `selectedSurface` and `surfaceArbitration`; a selected
  plugin SessionStart names the winner and adds its packaged core when an older
  or damaged global standalone loses; it explicitly does not claim that a
  legacy global core or registered hook copy was removed.
- Standalone and plugin manifests now declare surface protocol version 1. Plugin
  shadowing performs the complete manifest/tree/spec inspection only in the
  already-degraded dual-surface path; plugin-only hooks retain the fast path.

- Added `agentsmd repair --plan` and digest-bound `--confirm=<planDigest>` for
  standalone installs whose valid ownership manifest proves that registered
  files or directories are missing. Planning reports manifest/live inventory,
  local artifact identity, plugin availability, shared-only backups, blockers,
  and the recommended action without writing to `CODEX_HOME`.
- Confirmed repair captures a full pre-repair snapshot of deploy, skills,
  extended spec, manifest, and shared files before reusing the install
  transaction. Modified/unexpected bytes and unprovable ownership remain
  fail-closed. Apply also requires the source artifact version and complete
  deploy digest to match the ownership manifest, preventing repair from becoming
  an implicit update.

### Fixed

- Plugin hooks no longer yield merely because a standalone manifest, directory,
  and sentinel exist. Only a healthy same/newer standalone can shadow the plugin.
  Legacy standalone commands that a new plugin cannot disable remain an explicit
  doctor failure with an update/uninstall recovery action.
- Active global-spec inspection now honors `AGENTS.override.md` replacement
  precedence instead of falling through to `AGENTS.md` when the override exists
  without an agentsmd spec. Standalone health also requires the selected core
  bytes, ordered live wiring, and enabled hooks to match the deployed contract.
- Standalone config health now delegates full syntax/semantic acceptance to the
  installed Codex CLI in an isolated temporary home, while the text-preserving
  writer ignores feature-looking text inside TOML multiline strings. Malformed
  containers cannot manufacture health, and valid arrays-of-tables or multiline
  quote endings are not rejected by a partial local parser.
- Doctor freshness is directional: only a newer source recommends update; a
  newer deploy or build-metadata-only difference no longer suggests downgrade.

- Doctor no longer recommends a blind install for manifest-less partial or
  damaged states that the ownership preflight would reject; it directs users to
  the read-only repair classifier and reserves ordinary update for intact owned
  artifacts.

### Quality

- Release gates found zero README version-cascade offenders; version sync passed
  5/5, structured drift passed 25/25, and distribution/package lifecycle passed
  35/35. The npm dry-run artifact contains 93 files, including the repair and
  surface-arbitration runtime modules, while source-only tests remain excluded.
- Codex-dependent config-health tests now place a deterministic validator
  process on the test PATH, so CI exercises both accepted and rejected config
  results without inheriting a developer workstation's Codex installation.
- Independent architecture, quality, and spec re-reviews confirmed the original
  TOML false-health High and the hook-order/SemVer/freshness/exact-once wording
  findings closed, with no new High finding.

Rollback consumers by pinning `npm install -g @sdsrs/agentsmd@4.1.1` and running
`agentsmd update`; source/plugin users select `v4.1.1` and reinstall. Revert the
v4.2.0 release commit for source rollback. Published npm versions are immutable
and can only be deprecated.

## v4.1.1 — 2026-07-11 — plugin hook root repair

### Fixed

- Plugin hook commands now resolve from Codex's `CLAUDE_PLUGIN_ROOT` instead of
  the undefined `PLUGIN_ROOT`, so all 15 packaged hooks can start rather than
  exiting with code 127. The shared hook library maps that runtime variable to
  its internal plugin-root path for plugin-only spec injection and dual-surface
  suppression.
- Plugin-aware `status` and `doctor` validate the same runtime-root command
  contract that the packaged manifest executes.
- Tracked architecture documentation now distinguishes the runtime variable that locates
  a plugin entry hook from the support/spec paths scripts derive after startup.

### Quality

- Drift and packaged-distribution gates require all 15 commands to use
  `CLAUDE_PLUGIN_ROOT`. Hook smoke tests exercise plugin-only spec injection and
  standalone shadowing with only the Codex runtime variable present.
- Release validation covers 15/15 manifest commands, 274/274 hook smoke cases,
  978/978 full-suite assertions, and the 86-case user journey.

Rollback consumers with `npm install -g @sdsrs/agentsmd@4.1.0 && agentsmd
update`; source/plugin users select `v4.1.0` and reinstall. Revert the v4.1.1
release commit for source rollback. Published npm versions are immutable and can
only be deprecated.

## v4.1.0 — 2026-07-11 — trusted plugin runtime and safety audit remediation

### Added

- The Codex plugin manifest now explicitly selects its root `hooks.json` and
  resolves all 15 commands through `PLUGIN_ROOT`. A trusted plugin-only
  `SessionStart` injects the packaged core spec into the current session and
  announces the packaged extended-spec path without writing global Codex files.
- Plugin-aware `status` and `doctor` validate the manifest, all registrations,
  hook scripts and support files, both specs, prerequisites, and duplicate
  plugin/standalone surfaces. Complete standalone installs suppress the plugin
  hook copy to prevent duplicate execution.
- CI now runs the full suite on macOS and a separate 86-case user journey on
  Linux. The portable timeout fallback terminates the complete command process
  group instead of leaving descendants behind.

### Changed

- Project memory is explicitly untrusted data. Hints emit only validated
  repository-relative paths; ship evidence accepts only canonical, non-symlink,
  regular Markdown files up to 64 KiB inside the repository's real `memory/`
  directory. Transcript evidence is streamed across the complete session with
  bounded retained metadata.
- Session enforcement summaries remain available through explicit `status`
  inspection and are never injected into another session. Reports with a
  literal `Done:` label now require all four ordered outcome labels, including
  one- and two-label incomplete reports.
- Overlapping hard-rule subclauses inherit one governance parent so a shared
  telemetry bucket cannot emit duplicate promotion/demotion recommendations.
  Optional-workflow guidance is plugin-neutral, and turn-yield guidance records
  asynchronous, user-steered, and external-dependency pauses without treating
  them as completion.

### Fixed

- Shell safety detects `find -exec/-execdir rm`, BusyBox/Toybox `rm`, and
  `xargs rm`; it preserves remote provenance through `cp`, `mv`, `ln`, and
  `install`, while data heredocs no longer forge executable commands. A variable
  delete is exempt only after canonical `realpath`, non-empty, `/tmp/*`-bounded
  validation of the exact deleted variable.
- Restore revalidates each shared-file snapshot immediately before writing, so
  concurrent changes are rejected and already-restored files are rolled back.
- Session checkpoints recognize successful `functions.exec`-orchestrated edits,
  formatters, and validations without accepting markers inside strings/comments
  or failed outer calls.
- Memory-hint parsing runs from a packaged Node helper instead of a large
  command-substitution heredoc, preserving valid English and Chinese hints under
  stock macOS Bash 3.2.

### Quality

- Release validation covers plugin-only health, indirect command variants,
  malicious memory links, transcripts beyond 512 KiB, write-time restore races,
  incomplete reports, process-tree timeout cleanup, and modern orchestration.
  The hook smoke suite contains 274 passing cases and the user journey contains
  86 passing cases.
- On the same five-run synthetic baseline, `memory-prompt-hint` logic median
  moved from 78.3 ms to 27.3 ms; combined `UserPromptSubmit` hook medians moved
  from 93.3 ms to 42.6 ms.

Rollback consumers with `npm install -g @sdsrs/agentsmd@4.0.1 && agentsmd
update`; source/plugin users select `v4.0.1` and reinstall. Revert the v4.1.0
release commit for source rollback. Published npm versions are immutable and can
only be deprecated.

## v4.0.1 — 2026-07-11 — valid plugin hooks manifests and release synchronization

### Fixed

- Both shipped hook manifests now use the Codex-supported top-level
  `description` field instead of the project-local `_doc` field. Codex's strict
  plugin loader no longer rejects the npm plugin bundle with `unknown field
  _doc`.

### Quality

- `npm run release:version -- --version=<X.Y.Z>` synchronizes the package,
  plugin manifest, npm-backed marketplace pin, hard-rules manifest, and both
  shared spec headers with snapshot-checked writes. A failed later write rolls
  back earlier unchanged version edits without overwriting concurrent bytes.
- Version drift now checks all six structured release locations. The npm
  tarball E2E additionally reads both packaged hook manifests and enforces the
  strict `description` + `hooks` top-level schema, covering the artifact that
  Codex actually caches. npm publication runs the full `npm run check` suite
  through `prepublishOnly`.
- Documentation now states the update boundary explicitly: publishing a new npm
  version does not replace an already-installed Codex cache entry. Refresh the
  marketplace snapshot, reinstall the plugin, and start a new thread.

Rollback consumers with `npm install -g @sdsrs/agentsmd@4.0.0 && agentsmd
update`; source/plugin users select `v4.0.0` and reinstall. Revert the v4.0.1
release commit for source rollback. Published npm versions are immutable and can
only be deprecated.

## v4.0.0 — 2026-07-11 — consistent CLI usage failures and release QA

### Changed

- All top-level, subcommand, and standalone-installer argv/usage errors now exit
  with status 2. Status 1 is reserved for valid commands that report a negative,
  runtime, or health result; status 0 remains success/help. This is a breaking
  contract for automation that previously expected status 1 from malformed
  `init`, `analyze`, audit/governance, trend, or performance invocations.
- Top-level help, standalone help, and both READMEs document the shared
  `0`/`1`/`2` exit-code contract.

### Fixed

- The standalone installer rejects conflicting or repeated lifecycle actions
  before reading or mutating `CODEX_HOME`; a command such as
  `--status --uninstall` can no longer silently execute the final action.
- The Chinese README again exposes the project init/analyze/adoption/design
  workflows, plugin-browser fallback, and governance project lens.

### Quality

- Added a repeatable 87-case user journey using isolated multilingual/emoji
  fixtures, pipes, redirects, lifecycle misuse, package checks, and a full test
  run. All eight QA issues are verified. Release review additionally caught and
  closed option-like installer values before publication.

Rollback consumers with `npm install -g @sdsrs/agentsmd@3.3.0 && agentsmd
update`; source/plugin users select `v3.3.0` and reinstall. Revert the v4.0.0
release commit for source rollback. Published npm versions are immutable and can
only be deprecated.

## v3.3.0 — 2026-07-11 — ship authorization reuse and release closure

### Changed

- Explicit `commit + release/publish` intent now pre-authorizes the standard
  current-repository ship flow. Agents do not ask for a second confirmation
  before the already-requested merge, push, tag, or package publish.
- The ship checklist now ends only after the released commit is integrated into
  the default branch, the artifact/tag is verified, merged task/release branches
  are deleted locally and remotely, and the default-branch worktree is clean.
- Scope remains operation-bound: live `CODEX_HOME`, production deployment, a
  different repository/package/registry/environment, and unrelated Hard actions
  still require explicit naming.

### Fixed

- The memory ship gate recognizes successful reader commands nested inside the
  current Codex `functions.exec` orchestration transcript shape without allowing
  path-only commands to count as reads.

Evidence before release: drift 17/17 and hook smoke 240/240.

## v3.2.1 — 2026-07-11 — user-acceptance remediation

### Changed

- `hard-rules.json` now governs 39 rules. Reverse drift gates require every
  explicit HARD/MUST line and every §8 Never clause to have a manifest anchor;
  operational telemetry sections are declared separately from normative rules.
- Unknown-origin execution tracks resolved download destinations per session,
  resolves later relative execution against the event cwd, covers nested-shell
  downloads and compact output flags, and recognizes `fetch`, HTTPie, and
  `aria2c` alongside `curl`/`wget`.
- Memory ship evidence requires a successful `read_file` or explicit read
  command/output pair for the index and a linked memory file. Path-only commands
  and nonzero structured/text outputs do not count. Prompt hints name the
  absolute index base.

### Fixed

- V4 no longer attributes Codex's bwrap mount-staging directory to the task,
  and its advisory requires ownership verification before deletion.
- Secret scanning blocks `.env` and high-confidence private-key filenames in
  the effective commit while allowing `.env.example/.sample/.template`.
- Four-section observers flag a missing required label once report intent is
  established. Session checkpoints no longer count commit/push as validation,
  recognize direct project test commands, and keep formatter-only `ruff`/`biome`
  writes in the unvalidated state.
- Safety-coverage JSON drains fully through pipes, scans hook libraries, checks
  bypass documentation in both directions, distinguishes conditional guards
  from telemetry/message strings, and accounts for bypass telemetry.

Targeted evidence: sampling 21/21, drift 16/16, safety coverage 14/14, and hook
smoke 234/234.

## v3.2.0 — 2026-07-11 — additive audit remediation, safety routing, and distribution integrity

### Added

- `status` validates the ownership manifest identity, semver, timestamp, and
  complete deploy/extended/skill inventory. Its JSON now exposes
  `manifestValid` and `manifestError` instead of treating arbitrary JSON as an
  installed release.
- Project stack detection honors the `packageManager` declaration and modern
  `bun.lock`; project scanners delegate ignore decisions to Git for anchored,
  nested, glob, and negation semantics.
- The Codex plugin manifest includes a bounded starter prompt.

### Changed

- The repo marketplace replaces its local checkout source with the pinned
  published npm artifact. npm and standalone deployment omit source-only
  hook/script test trees.
- All 15 skills resolve scripts from the selected `SKILL.md` path first and use
  the standalone `CODEX_HOME/agentsmd` tree only as a fallback, covering plugin
  cache, repository checkout, and standalone layouts.
- Install/update/uninstall, migration, analyze/init/design writers, and
  multi-file design updates use snapshot-checked atomic writes and conditional
  rollback. Documentation states the remaining portable POSIX
  check-to-rename/unlink boundary instead of claiming an atomic filesystem CAS.
- Session checkpoint and summary state is preserved for resumable sessions and
  surfaced only after the seven-day expiry boundary; validation evidence counts
  only commands executed after the final edit.

### Fixed

- TOML mutation handles quoted/dotted tables, inline tables, nested delimiters,
  trailing comments, deprecated `codex_hooks`, and dual-false legacy/canonical
  keys without producing duplicate shared configuration.
- Hook ownership is derived from the executed Bash script operand rather than a
  path substring. Shell/Git parsing now covers bounded nested shell/eval forms,
  here strings, interpreter code substitution, redirected download execution,
  explicit current-directory `PATH`, multi-ref pushes, and exact target repos.
  Bash 3.2 empty-array handling no longer aborts `--all`/`--branches` or memory
  repository resolution on macOS; target-bound memory evidence recognizes the
  equivalent `/var` and `/private/var` spellings plus repeated separators
  produced by macOS temporary paths.
- Secret scanning models staged, `--all`, `--include`, `--only`, bare pathspec,
  and pathspec-file commit content without mutating the real index. Ship and
  memory gates bind CI and consultation evidence to every target repository.
- Legacy telemetry migration is retry-safe across append/delete failures;
  sampling excludes future mtimes; missing safety-coverage hook filters fail
  with a clean nonzero result; doctor failures propagate through `install.sh`.
- `init --local` rolls back a newly-created local preferences file when its
  `.gitignore` update loses a concurrent-write check, and design's two-file
  writer preserves third-party bytes on rollback conflicts.

Release validation: `npm run check` exited 0 (install 195/195, init 96/96,
safety coverage 12/12, distribution 32/32, hook smoke 206/206, ShellCheck
clean); version cascade and argv lint passed; all 15 skills and the plugin
manifest validated; npm publish dry-run packed 86 files as 3.2.0; outgoing diff
secret signature scan found 0 hits. Roll back npm/live consumers with
`npm install -g @sdsrs/agentsmd@3.1.0 && agentsmd update`; source/plugin users
select `v3.1.0` and reinstall. Revert the v3.2.0 release commit for source
rollback. Published npm versions are immutable and can only be deprecated.

## v3.1.0 — 2026-07-10 — change: risk-based workflow, operation-scoped AUTH, and a smaller core

### Changed

- LEVEL is based on reversibility, contract impact, persisted data, security,
  production, infrastructure, and external-state boundaries instead of LOC or
  file count. A coordinated multi-component change is L2; a large but cohesive,
  reversible local fix is not upgraded by size alone.
- LEVEL and AUTH are orthogonal. L3 still requires its extended workflow,
  blast-radius statement, checkpoint, and validation, but no longer asks for a
  second approval merely for being L3. Concrete destructive, data, CI,
  production, security, global Codex configuration/routing, breaking API, and
  ship operations retain hard authorization.
- LLM-visible metadata uses risk tiers: scoped reversible project metadata is
  L2; global/shared/security-sensitive routing remains L3. Unknown-origin script
  execution remains forbidden by §8 and is no longer listed as authorizable.
- L2/L3 reports always render `Done`, `Not done`, `Failed`, and `Uncertain` as
  four independent bold labels. Empty values stay visible as `none` instead of
  being omitted or collapsed into a combined line.
- The always-loaded core moved repeated rationale and examples to the triggered
  extended layer, shrinking from 16,300 B to 12,787 B (-21.6%). The drift ceiling
  is now 15 KiB, and a new gate prevents foundational safety/auth/evidence/
  worktree/report rules from being moved out of core to satisfy the byte budget.

No hooks or live telemetry sections changed. Release validation: `npm run check`
exited 0 (drift 14/14, safety coverage 11/11, distribution 31/31, hook smoke
169/169, shellcheck clean); version cascade found 0 stale prose tokens; npm publish
dry-run packed 105 files as 3.1.0. Roll back npm consumers with
`npm install -g @sdsrs/agentsmd@3.0.0 && agentsmd install`; plugin/source users
select `v3.0.0` and reinstall. Revert the v3.1.0 release commit/tag for source
rollback. Published npm versions are immutable and can only be deprecated.

## v3.0.0 — 2026-07-10 — change: safe lifecycle recovery, shell-aware safety checks, and strict CLI contracts

### Changed

- `agentsmd install` / `update` now print a one-line result by default; `--json`
  emits the complete install manifest for automation. Help and invalid options
  are parsed before any lifecycle mutation, and the `update` alias retains its
  own command name in help and errors.
- `init --check`, `--dry-run`, and `--local` are explicit mutually exclusive
  modes instead of silently ignoring a later mode.

### Added

- `agentsmd rules --include-test` now includes test-tagged telemetry in both the
  global governance signal and the project-scoped lens. Top-level help documents
  the flag and the complete command surface.

### Fixed

- Restore snapshots record lifecycle purpose and their derived agentsmd
  hooks/spec footprint. Default and explicit restores reject state mismatches,
  legacy snapshots are classified from their bytes, multi-file restore failures
  roll back earlier writes, and failed backup creation leaves no partial snapshot.
- The §8 safety parser now binds `rm -rf` expansions to actual targets and covers
  bounded shell/eval command strings, quoted or escaped command words, `env -S`,
  versioned interpreters, process/command/backtick substitution, and clustered
  curl/wget output flags. Inspection paths such as `bash -n` and
  `python -m json.tool` remain allowed.
- `sampling-audit` rejects unsafe-integer limits; `analyze` rejects duplicate
  `--days` / `--project` / `--from` values and no longer consumes an option as a
  missing `--from` path.
- The shell smoke suite uses `fs.utimesSync` instead of GNU-only `touch -d` for
  its aged fixture.

No hooks were added or removed (15 remain), and no core/extended rule text
changed. Release validation: backup 18/18, distribution 31/31, hook smoke
169/169, with every other `npm test` suite at 0 failures. This is a major
release because changing the default lifecycle stdout can break callers that
parsed the prior manifest-shaped output. Rollback an npm install with
`npm install -g @sdsrs/agentsmd@2.17.0 && agentsmd install`; standalone/plugin
users must select the `v2.17.0` source and reinstall its managed footprint.
Revert the `v3.0.0` release commit for source rollback. npm versions are
immutable, so a published `3.0.0` can only be deprecated.

## v2.17.0 — 2026-07-10 — change: transactional lifecycle, bounded governance telemetry, and 16 KiB core

- Added quote-aware Git invocation parsing and `commit -a/--all` secret scanning.
- Added manifest-backed lifecycle ownership, staged transactions, failure
  rollback in both install and uninstall, mode-preserving atomic writes, legacy
  recovery snapshots, exact compatibility-shim reinstall ownership, and stricter
  doctor inventory checks.
- Narrowed ship-hook claims to known-red remote status and added CI for Node
  18/20/22/24 plus shellcheck.
- Serialized telemetry rotation/append and changed governance denominators to
  per-rule eligible/evaluated opportunities.
- Reduced core to the 16 KiB budget; moved detail to extended, followed the
  user's language, made repository memory opt-in, and added bilingual recall and
  skill-routing fixtures.
- Synchronized capability wording, hook-event manifests, SQL safety semantics,
  `npx` advisory classification, architecture, and drift gates.

No hooks were added or removed (15 remain). Rollback: pin npm consumers to
`@sdsrs/agentsmd@2.16.0` and revert the `v2.17.0` release commit; npm versions
are immutable, so a published `2.17.0` can only be deprecated, not replaced.

## v2.16.0 — 2026-07-07 — fix: git-global-option hook evasion + config atomicity + telemetry rotation; new drift/doctor gates

Minor release closing a batch of correctness, safety, and honesty findings from the
2026-07-07 full-project audit. No new hooks (count stays 15). No core/extended spec
rule-text change; the shared version moves in lockstep (`spec_version` → v2.16.0).
One manifest change: `§8-home-traversal` relabeled from a false `enforcement:"both"`
to the honest `"self"`. Revert by pinning `npm i -g @sdsrs/agentsmd@2.15.4`.

### Fixed (correctness / safety)
- **Git global options no longer evade the four git-gated hooks**
  (`hooks/lib/hook-common.sh` + `secrets-scan` / `ship-baseline-check` /
  `banned-vocab-check` / `memory-read-check`): the gate regex required the
  subcommand to immediately follow `git`, so `git -C <dir> push`, `git -c k=v
  commit`, and `git --git-dir=<d> merge` slipped past every gate — including the
  immutable `§8-secrets` commit scan. A shared `hook_cmd_invokes_git` helper now
  consumes optional git global options before the subcommand. `secrets-scan`
  additionally diffs the `-C <dir>` target repo, not the event cwd.
- **`uninstall` / `migrate` now write shared multi-tenant files atomically**
  (`scripts/uninstall.js`, `scripts/lib/migrate.js` via `backup.writeFileAtomic`):
  install already used tmp+rename; uninstall/migrate wrote `hooks.json` / `AGENTS.md`
  raw, so an interrupt or ENOSPC mid-write could truncate a file holding another
  tenant's (OMX's) hooks with no recovery. `uninstall` also takes a pre-mutation
  backup.
- **`audit` now reads rotated telemetry segments** (`scripts/audit.js` `readRows`):
  it read only the live `agentsmd.jsonl`, so hits that rotated into `.1` / `.2` at
  the size cap counted zero — inverting the demote signal exactly when telemetry was
  richest. It now merges the live log with its rotations.
- **`memory-read-check` bounds its transcript read to a 512 KiB tail**: an unbounded
  `readFileSync` degraded the ship-memory gate to a timeout no-op on long sessions.

### Changed (honesty / governance)
- **`§8-home-traversal` relabeled `enforcement:"both"` → `"self"`** in
  `spec/hard-rules.json`: no hook ever implemented it, so the manifest claimed a gate
  that did not exist. Now matches the `§8-sql-no-where` precedent; a narrow detector
  stays a documented, not-yet-built plan. `live_sections` unchanged (it was never live).
- **`§10-V` shared bucket documented**: `§6-bugfix-anchor` and `§10-specificity`
  deliberately share one telemetry section; both manifest notes now say so.

### Added (observability / DX / drift-proofing)
- **Three new `drift.test.js` gates**: core spec byte budget (`< 32768`, the
  silent-truncation cap — previously ungated, and its manual `Sizing` backstop had
  drifted +628 B), README EN+zh hook-table row count vs the wiring, and a
  comment-stripped emission check so a `live_section` named only in a hook comment
  can no longer green.
- **Two new `doctor` checks**: `hooks.json parseable` (distinguishes an unparseable
  shared file — which wedges install/uninstall — from "0 hooks registered"), and
  `install state consistent` (names a partial install where hooks are live but the
  manifest is missing, instead of printing "15/15 ok" alongside "not installed").
- **`install.sh` warns on missing `jq` and auto-runs `doctor`** after install, so a
  jq-less machine no longer reports success while every hook silently fails open.
- **`manifest.version` recorded and surfaced as `status.installedVersion`.**
- **README (EN + zh) + `CLAUDE.md` corrected**: the hook table listed 12 / 10 rows
  and "five events" for a 15-hook / 4-event layer; the `npm test` suite count and
  "version in 4 places" (now 5) claims were stale.
- **`smoke.sh`**: full block-object-shape assertion (decision + reason +
  systemMessage + hookEventName) and both-kill-switch coverage; `git -C` evasion
  regression cases for all four git-gated hooks.

### Deferred (tracked, not in this release)
- `rules.js` exposure denominator by rule live-window and a bypass-vs-blocking demote
  split (governance stays frozen until real Codex sessions accrue); a banned-vocab
  spec⊆patterns coherence gate; the `§8-home-traversal` detector hook.

## v2.15.4 — 2026-07-07 — fix: remote-exec variants + status/doctor CLI help

Patch release for two end-to-end defects found during a six-round real-user
exercise of the CLI, installer, hooks, telemetry, project-init, and release
paths. No new hooks (count stays 15), no spec rule-text change, no breaking CLI
contract. Revert by pinning `npm i -g @sdsrs/agentsmd@2.15.3`.

### Fixed
- **Remote script execution checks now cover non-pipe forms**
  (`hooks/pre-bash-safety-check.sh`): the §8 unknown-origin script hook already
  blocked `curl|wget ... | shell`, but allowed equivalent real-world forms such
  as `bash <(curl ...)`, `sh -c "$(curl ...)"`, and `eval "$(wget ...)"`.
  These now block under the same `§8-unknown-script` rule. Inspect-first flows
  such as `curl -o file; cat file` remain allowed.
- **`agentsmd status` and `agentsmd doctor` help/error output is actionable**
  (`scripts/status.js`, `scripts/doctor.js`): `--help` now explains what each
  command reports/checks, and unknown options exit 2 with the full usage instead
  of a one-line usage or missing usage text.

### Internal
- Hook smoke coverage adds the three remote-exec variants above, taking the
  smoke suite to 106 checks.
- Regression tests cover the improved `status`/`doctor` CLI behavior.
- A project memory note records the remote-exec variant class for future hook
  work. `npm test`: 19 suites, 0 failed.

## v2.15.3 — 2026-07-06 — fix: cached-hook uninstall shims + analyze argv mode validation

Patch release for two real end-to-end defects found while exercising the CLI and
install lifecycle like a user. No new hooks (count stays 15), no spec rule-text
change, no breaking CLI contract. Revert by pinning
`npm i -g @sdsrs/agentsmd@2.15.2`.

### Fixed
- **Uninstall no longer leaves the current Codex session with exit-127 hook
  failures** (`scripts/uninstall.js`): after unregistering agentsmd and removing
  the real install/state/spec footprint, uninstall now leaves tiny unregistered
  no-op shell shims at the old `$CODEX_HOME/agentsmd/hooks/*.sh` command paths.
  Codex can keep a session's hook command list cached until restart; before this
  fix, those stale commands ran `bash "missing-hook.sh"` and failed with exit
  127 after uninstall. A later install overwrites the shims with the real hooks.
- **`doctor` distinguishes shim-only state from an install**
  (`scripts/doctor.js`): a leftover compatibility shim directory is reported as
  "not installed" when the agentsmd manifest is gone, so health checks stay
  honest.
- **`agentsmd analyze` rejects misleading argv combinations**
  (`scripts/analyze.js`): `--days` / `--project` now require `--adoption`,
  `--from` requires `--write`, and explicit modes (`--gather`, `--write`,
  `--adoption`) are mutually exclusive. Previously `analyze --days=7` and
  `analyze --adoption --gather` exited 0 while silently running gather.
- **`secrets-scan` handles private-key patterns correctly**
  (`hooks/secrets-scan.sh`): regexes that begin with `-`, such as
  private-key PEM headers, are now passed to `grep` after `--` so they are
  treated as patterns rather than options. The hook now blocks staged private-key
  headers as intended without adding a secret-shaped literal to the release notes.

### Docs / Internal
- README uninstall docs now describe the unregistered compatibility shims.
- Regression tests cover shim execution after uninstall, shim-only status/doctor
  behavior, analyze argv rejection paths, and private-key header blocking.
  `npm test`: 19 suites, 0 failed.

## v2.15.2 — 2026-07-06 — fix: parser robustness (strings / comments / parens) + argv-gate coverage, from a second code review

Second bugfix patch, from a code review of the v2.15.1 release. Hardens the `agentsmd design` token parser against string / comment / paren edge cases (each previously emitting a wrong or dropped "fact"), widens the `lint-argv` gate to `findIndex`/`filter`, and fixes two Minor correctness notes. No new hooks (count stays 15), no spec rule-text change. Revert by pinning `npm i -g @sdsrs/agentsmd@2.15.1`.

### Fixed
- **Design-token parser is now string / comment / paren aware** (`scripts/lib/design-tokens.js`): a `;` inside `url("data:…;base64,…")` or a quoted value no longer truncates the value; a `/* … */` inside a string value is preserved; a `:root{`/`@theme{` (or a stray `{`/`}`) inside a string value is no longer read as block structure. Block/brace matching runs on a structural view with string contents blanked, while values are sliced from the real CSS.
- **`renderDesignMd` guards a non-frontend report** (`scripts/design.js`): returns a safe note instead of throwing for direct callers (unreachable via `writeDesign`, which skips non-frontend at its call site).
- **`lint-argv` gate widened + tightened** (`scripts/lint-argv.js`): the antipattern scan now catches `findIndex`/`filter` (not just `find`), and its literal must be flag-shaped (`--<letter>`) so a `--- separator ---` string is not flagged. Explicit `arg === '--flag'` dispatch is intentionally left unflagged — a normal, non-silent branch that scan B already governs.
- **`version-cascade` token boundary** (`scripts/version-cascade-check.js`): a version-shaped substring glued to a preceding word char / dot no longer registers as a stray token.
- **`perf-baseline` median** (`scripts/perf-baseline.js`): an even-N sample now averages the two middle values instead of returning the upper-middle.

### Internal
- Regression tests for each case: `design-tokens` 9→13, `design` 11→12, `perf-baseline` 2→3; `lint-argv` + `version-cascade` gain teeth for the new cases. `npm test`: 19 suites, 0 failed. `lint-argv` real-repo scan: 0 hits.

## v2.15.1 — 2026-07-06 — fix: comment-aware design-token extraction + honest truncation note

Bugfix patch for `agentsmd design` (v2.15.0), surfaced by a code review of the D1 release. The deterministic token parser now strips CSS comments **before** matching blocks, and the no-tokens note discloses a truncated scan. No change to any other command; no new hooks (count stays 15), no spec rule-text change. Revert by pinning `npm i -g @sdsrs/agentsmd@2.15.0`.

### Fixed
- **Comment-aware block extraction** (`scripts/lib/design-tokens.js`): `extractBlocks` strips `/* … */` before brace-matching. Previously a `}` inside a comment prematurely closed a `:root{}`/`@theme{}` block (silently dropping every token after it in that file), and a commented-out `:root{}` block's stale values could override the live ones (last-definition-wins) — both emitting wrong "facts" into a facts-only doc.
- **Honest truncation on an empty scan** (`scripts/design.js`): when the file/byte cap zeroes the token count, `DESIGN.md`'s "no tokens found" note now also discloses that the scan was truncated — "none found" is no longer a false all-clear. Both render branches share one truncation note.
- **Doc-vs-behavior**: the `AGENTS.md` pointer is *appended to the file* (not placed under `## Frontend`); `agentsmd-design`'s `SKILL.md` (LLM-visible metadata), `README.md`, and the v2.15.0 note are corrected to match.

### Internal
- Regression tests: `design-tokens` 7→9 (brace-in-comment; commented-out block does not override), `design` 9→11 (truncation disclosed in both the no-tokens and has-tokens branches). `npm test`: 19 suites, 0 failed.

## v2.15.0 — 2026-07-06 — design-adopt: extract a project's design tokens into a facts-only DESIGN.md

New capability (Workstream D — the last roadmap item). `agentsmd design` parses a frontend project's design tokens — CSS `:root` custom properties + Tailwind v4 `@theme` — into a facts-only, sentinel-managed `DESIGN.md`, plus a one-line pointer appended to `AGENTS.md`. Deterministic (tokens are facts — no AI step), command-only, consent-gated (previews by default; `--write` commits), stateless. Realizes the "Phase 2" module `detect.js:6` has flagged since the project began. Revert by pinning `npm i -g @sdsrs/agentsmd@2.14.0`.

### Added
- **`agentsmd design`**: `detectFrontend` → parse `:root`/`@theme` custom properties → group by category (colors / spacing / typography / radii / shadows / z-index / breakpoints / other) → write a facts-only `DESIGN.md` managed block + an `AGENTS.md` pointer. Default previews (writes nothing); `--write` commits. Keeps `AGENTS.md` lean (a one-line pointer, not the tokens); the agent reads `DESIGN.md` on demand. Budget-guarded (refuses, never truncates, past the block cap). Non-frontend project → no-op; no tokens found → an honest note (Tailwind v3? its theme is in `tailwind.config.js`, not yet parsed). Runs against the current project directory, like `init` / `analyze`.
- **`scripts/lib/design-tokens.js`**: the deterministic parser — ignore-aware capped `.css` scan, brace-matched `:root`/`@theme` block extraction, `--name: value` declarations, name-prefix + value-sniff categorization, last-definition-wins dedupe. No JS eval (a Tailwind v3 config-object theme is a documented non-goal).

### Internal
- New suites: `design-tokens` (7), `design` (9, incl. preview-writes-nothing, idempotent re-run preserving user content, budget refusal, non-frontend no-op). `agents-md.js` gains DESIGN + design-pointer sentinel constants; new skill `agentsmd-design`. No new hooks (count stays 15), no spec rule-text change, no `hard-rules.json` rule added. All additive, no breaking changes.

## v2.14.0 — 2026-07-06 — dev-ergonomics batch: measured hook latency, a free-text version gate, a hook single-source-of-truth, a review-cadence signal, and an argv-antipattern gate

Dev-ergonomics / tooling batch (Workstream E). **No new hooks, no spec rule-text change, no user-visible default behavior change** — the hook count stays 15 and nothing new blocks or surfaces. Five additive operator/CI tools + one governance signal, all read-only. Revert by pinning `npm i -g @sdsrs/agentsmd@2.13.0`.

### Added
- **`agentsmd perf-baseline`**: measures the real wall-clock latency each hook adds — median over N runs of OFF (`DISABLE_AGENTSMD_HOOKS` kill-switch floor) vs ON, grouped by Codex event — so the per-turn cost is a measured number, not an estimate. Runs hooks in an isolated `CODEX_HOME` sandbox (writes nothing to the live `~/.codex` — §8.V3/V4); numbers are a lower bound (exclude Codex's harness round-trip).
- **`agentsmd version-cascade`**: free-text version-drift gate — scans the prose READMEs for a same-major version token drifted off the current minor, complementing drift gate #5 (which only checks named JSON/header fields). Intentional historical/example refs are allowlisted by exact token. Wired into `npm test`.
- **`agentsmd lint-argv`**: gate against the "silent-fallback argv" bug class — `args.includes('--x')` / `.find(a=>a.startsWith('--'))` / `.indexOf('--x')` and a `require.main===module` block with no argv parser. The class is currently absent; this locks it out. Wired into `npm test`.
- **`scripts/lib/hook-registry.js`**: single source of truth for the 15 hooks + their kill-switch suffixes. `status` now reports which hooks are switched off (`killSwitches`); `doctor` sources its expected-hook count from it; a new `hook-registry.test.js` asserts the registry never drifts from either `hooks.json` wiring or any hook's own `hook_kill_switch` call.
- **`scripts/lib/argv.js`**: shared strict argv parser — `parseStrict` (`--key=value` only, unknown flags rejected loudly), `parsePositiveInt` (rejects `Number()`/`parseInt` coercion footguns like `1e2` / `0x1e`), `printHelpAndExit`. Used by the new CLIs; the substrate `lint-argv` points fixes at.
- **`agentsmd rules` `staleReviews`**: a review-CADENCE signal — rules whose `last_demote_review` is null or older than the window — surfaced in the report. Orthogonal to the hit-based demote signals (a rule can be `active` yet overdue for a human review).

### Internal
- New suites: `argv` (11), `hook-registry` (6), `version-cascade-check` (7), `lint-argv` (3, incl. a synthetic-broken-tree teeth check), `perf-baseline` (2, incl. a sandbox-isolation assertion); `audit` 63 → 67 (+4 staleReviews). Three new skills (`agentsmd-perf-baseline` / `-version-cascade` / `-lint-argv`). Hook count unchanged (15); no `hard-rules.json` rule added, no `live_sections` change. All additive, no breaking changes.

## v2.13.0 — 2026-07-06 — self-healing + coverage batch: rollback backups, a doc-vs-code gap gate, a cross-session summary banner, and two honesty observers

Continues the observability / self-healing arc of v2.12.0. **User-visible default change (per the released-artifact rule): a new fail-open Stop hook `session-summary`, taking the hook count 14 → 15**, plus two new detections in the existing `transcript-structure-scan` Stop hook. Nothing new blocks; all surface a queued advisory only when actionable. `install` now also takes a rollback snapshot of the three shared files before merging. Revert the whole release by pinning `npm i -g @sdsrs/agentsmd@2.12.0`.

### Added
- **`session-summary` hook** (Stop) + SessionStart banner: aggregates a session's enforcement telemetry (denials / bypasses / most-active spec section) from the log tail into a per-session file; the next session surfaces the most-recent OTHER session's summary once as a one-line self-awareness banner, then deletes it. Windowed (O(1)/Stop) + atomic per-session write; agent-facing `additionalContext`, zero user action. Hook count 14 → 15.
- **Two honesty observers in `transcript-structure-scan`** (Stop): (1) an **iron-law-2 evidence-fingerprint** — a completed-fix claim (fixed / resolved) with no evidence anchor anywhere (test count / `file:line` / exit code / commit hash / failing-state token) records under `§6-iron-law-2`; (2) an **uncertain-hedge** check — an Uncertain section that hedges (may / could / might) without a "because" records under `§10-honesty`. Both queue an advisory; each spec section gets its own telemetry row. This moves `§6-iron-law-2` and `§10-honesty` from self-enforced to hook-observed (`live_sections`; `demote_policy: deterrence` — a foundational rule stays core regardless of hit count).
- **`agentsmd safety-coverage-audit`**: static "does the hook IMPLEMENT what its header CLAIMS" gap detector — arrow-claim sweep (a multi-clause `→` claim with an unimplemented clause), manifest cross-ref (a live rule no hook emits), bypass-token coverage (a documented `[allow-*]` with no code guard), and orphan emission (a `§`-section a hook emits that no rule declares). Exit 3 on any gap; wired into `npm test` as a coherence gate.
- **`agentsmd restore` + pre-install backups**: `install` now snapshots the three shared multi-tenant files (`hooks.json` / `config.toml` / `AGENTS.md`) before merging — rotated (keep 5), in agentsmd's own state dir. `restore` rolls them back (dry-run by default, `--confirm` writes); it overwrites only files present at backup time and never deletes one absent then (`uninstall` stays the marker-scoped remover for agentsmd's own entries).
- **`§9-parallel-path` manifest rule** (self-enforced): the §9 parallel-path completeness rule (enumerate + verify every branch), already live prose in core §9, is now a first-class governed `hard-rules.json` entry.

### Changed
- **`install` records a `backup` id** in its manifest and snapshots the shared files before any mutation — atomic-write already made a merge crash-safe; this makes it reversible if a merge is logically wrong. Best-effort: a backup failure never blocks the install.

### Internal
- Hook count 14 → 15; new suites `safety-coverage` (11, incl. a synthetic-broken-tree teeth check) + `backup` (8, round-trip + rotation); smoke 94 → 102. `hard-rules.json` 31 → 32 rules; `live_sections` +2 (`§6-iron-law-2`, `§10-honesty`); `_demote_policy_doc` broadened to cover foundational core observers alongside immutable §8. `session-start-check` GC sweeps `session-summary-*.json`. All additive, no breaking changes.

## v2.12.0 — 2026-07-06 — observability + self-healing batch: two Stop-hook safety nets, three telemetry CLIs, and the mid-SPINE turn-yield rule

The largest governance/observability batch since the closed loop landed — it makes the previously-invisible measurable (self-enforced rules, memory follow-through, rule-usage trend) and adds two quiet self-healing Stop hooks. **User-visible default change (per the released-artifact rule): two new fail-open Stop hooks, taking the hook count 12 → 14.** Neither blocks; both surface a queued advisory only when genuinely actionable. Revert the whole release by pinning `npm i -g @sdsrs/agentsmd@2.11.0`.

### Added
- **`session-exit-checkpoint` hook** (Stop, §7-session-exit): flags a turn that ran `apply_patch` with no test/lint/typecheck/commit afterward — one advisory per unvalidated streak + a per-session flag that the next SessionStart surfaces once from a prior session ("prior session left edits unvalidated"), then self-clears when a later turn validates. Targets Iron Law #2 ("ran" ≠ "verified"). Added to `hard-rules.json` `live_sections`.
- **`mem-audit` hook** (Stop, §7-memory-hygiene): audits the resolved `MEMORY.md` for index_orphan / file_orphan / missing `verified:/source:` header. A surfaced advisory only for orphans (a broken pointer the memory hint routes off); missing headers are recorded to telemetry but never surfaced. 24h per-dir debounce; depth-1 read (§8); fail-open. New `§7-memory-hygiene` rule + `live_sections` entry.
- **`agentsmd sampling-audit`**: retrospective scan of the self-enforced §10 rules (banned-vocab, four-section order) across Codex transcripts — the real violation rate the per-turn hook cannot measure. Shares the hook's exact detection (parity-tested).
- **`agentsmd lesson-bypass-audit`**: memory cite-recall = applied / (applied + bypassed). `memory-prompt-hint` now emits a `suggest` event carrying the surfaced filenames to make the join possible.
- **`agentsmd sparkline`**: multi-window rule-usage trend (↗/↘/≈ per section) with a went-silent flag catching a rule that silently stopped firing — which a single-window point count hides. `--markdown` emits a CHANGELOG block.
- **`agentsmd audit`** gains `byFailOpen` (silent enforcement loss by hook/reason) and `denyByProjectClass` (self-dogfood vs external, so this repo's own traffic can't inflate enforcement value).
- **Extended spec rule §E8 MID-SPINE TURN-YIELD** (self-enforced): the per-turn analog of core §7 Session-exit — a silent mid-cycle turn-yield + next-turn "done" claim is an Iron Law #2 evasion. In extended (byte budget); `§E8-turn-yield` in `hard-rules.json`.

### Changed
- **`memory-prompt-hint` telemetry**: records a `suggest` event with the surfaced `memory/*.md` filenames instead of a bare match count. The user-facing hint is unchanged; old `hint` rows stay under `§7-memory-read`.

### Internal
- `session-start-check` GC now sweeps `unvalidated-*.flag` + `mem-audit-*.stamp` (7-day floor). New suites: `sampling-audit` (18, incl. JS↔bash parity), `lesson-bypass-audit` (10), `sparkline` (22); smoke 82 → 94. `hard-rules.json` 29 → 31 rules. All additive, no breaking changes.

## v2.11.0 — 2026-07-05 — quieter convention telemetry + facts-only frontend section

Two refinements to user-visible behaviors shipped in v2.8.0 / v2.9.0, from a cross-project review of the project-layer feature set. Both change what the plugin writes into a project's `AGENTS.md`; neither touches a spec rule or a CLI contract. Revert by pinning `npm i -g @sdsrs/agentsmd@2.10.0`.

### Changed
- **Convention-adoption citations move out of user-visible prose.** The citation instruction that `agentsmd analyze --write` writes into a project's `AGENTS.md` now directs a single trailing `<!-- adopted-conventions: @conv-<dim> … -->` HTML comment on the last line of a message, instead of inline `(@conv-x)` in the prose the user reads — the adoption signal no longer intrudes on the answer. The `convention-cite-scan` Stop hook is unchanged (its `@conv-<slug>` scan is position-independent). The written notice references anchors only via the inert `@conv-<dim>` placeholder — a real slug there would be extracted off disk as a phantom known-anchor and a false prune candidate.
- **`agentsmd init` frontend section trimmed to stack facts.** The generated `## Frontend` block now carries only the detected stack line (e.g. `- Stack: React (Next.js) · TypeScript · UI: Tailwind`); the generic per-stack best-practice bullets — model-known boilerplate that taxed every turn's discovery-chain context without being specific to the project — are removed. `--no-frontend` still suppresses the whole section.

### Internal
- `spec/OPERATOR.md` §O8 documents the convention-adoption review cadence (never prune off an `insufficient-exposure` window; prune on the negative only) with an honest ship-day baseline (0 cites recorded). No core or extended rule text changed; the shared spec version moves in lockstep.

## v2.10.0 — 2026-07-05 — secret-scan gate, governance exposure model, safety + telemetry-integrity fixes

The largest enforcement + governance batch since the closed loop landed. **User-visible default change (per the released-artifact rule): a new blocking hook `secrets-scan` gates `git commit`** — if the staged diff ADDS a line matching a high-confidence secret shape (AWS / GitHub / Slack / Google / Stripe keys, private-key headers), the commit is blocked (§8, immutable). Prefix-anchored patterns keep false positives low; bypass a documented example with `[allow-secret]`. This takes the hook count 11 → 12. Revert the whole release by pinning `npm i -g @sdsrs/agentsmd@2.9.0`.

The governance loop (`agentsmd rules`) is now statistically honest: it no longer flags a rule as dilution off thin or misattributed data. And two latent safety/integrity defects are fixed — one that could fail a `git push` on the hook's own crash, and one that could write invalid TOML into the shared `config.toml`.

### Added
- **`secrets-scan` hook** (PreToolUse:Bash, §8): scans `git diff --cached` added lines against `hooks/secrets.patterns`; blocks a commit that stages a secret. Fail-open (jq/git missing, not a repo, empty diff), `[allow-secret]` bypass.
- **Governance exposure model** (`agentsmd rules`): `demote_policy: "deterrence"` on the immutable §8 hooks (0 hits = the hazard never arose, never "dilution"); extended-scope hook rules with 0 hits now read `hook-value-review` (nowhere to demote to), not `demote-candidate`; and a `MIN_EXPOSURE_SESSIONS` distinct-session gate reads a thin window as `insufficient-exposure` instead of demoting off too little field data.
- **Telemetry provenance tag**: `AGENTSMD_TELEMETRY_TAG=test` stamps a `tag` field; `audit`/`rules` exclude tagged rows by default (`audit --include-test` keeps them) so a verification run against a real `CODEX_HOME` can't skew the ledger.
- **`doctor`** gains two checks: `installed spec is current` (deployed `~/.codex/AGENTS.md` version vs the source — catches a lagging install) and `discovery-chain headroom for project docs` (global spec bytes vs `project_doc_max_bytes`).
- **Chain-budget warning** in `init` / `analyze --write`: warns when the global + project `AGENTS.md` would exceed `project_doc_max_bytes` (Codex silently truncates past it).

### Fixed
- **`memory-read-check` could fail CLOSED**: only a clean detector exit 1 now blocks the push; a crash/OOM/signal (exit 137/139/143) fails open. A tool malfunction no longer blocks a `git push`.
- **`config-toml` wrote invalid TOML into the shared `config.toml`** on two valid inputs: the inline-table form `features = { hooks = true }` appended a duplicate `[features]` table, and `hooks = false` + `codex_hooks = true` produced a duplicate `hooks` key — both rejected by Codex's TOML parser (fail-closed for every tenant). The scanner is now inline-table-aware and the migration dedupes. Same fix for inline `[tui]`.
- **Telemetry section mislabel**: `transcript-structure-scan` recorded banned-vocab hits under `§10-four-section-order`; they now record under `§10-V`, keeping the promote/demote ledger accurate.
- **`pre-bash-safety` detection gaps**: `rm -rf` now also catches `$1` / `${1}` / `$@` / `$*` / `$(…)` targets; the remote-exec check catches multi-stage pipelines (`curl … | grep … | bash`).
- **`ship-baseline`** now gates dash-suffixed shared branches (`release-1.2`, `prod-east`), previously unmatched; the run's `headSha` + `createdAt` are surfaced for freshness judgement.
- **`analyze --adoption --days=<huge>`** threw an uncaught `RangeError`; the day bound now lives inside `audit()` so every caller is safe.
- **Unparseable shared `hooks.json`**: `uninstall` now aborts (like `install`) instead of silently orphaning agentsmd's entries.

### Changed
- **Shared-file writes are atomic** (temp + rename) in `install` — a torn write can no longer corrupt the shared `hooks.json` / `config.toml` / `AGENTS.md`.
- **Per-session state**: the sandbox-disposal reference and residue baseline are now keyed per session (`session-start-<sid>.ref`, `tmp-baseline-<sid>.txt`), so parallel sessions don't clobber each other's baseline; SessionStart GCs state files older than 7 days.
- **Stop scans read only the transcript tail** (last 512 KiB) — the per-turn cost is now O(1), not O(transcript).
- `spec/AGENTS-extended.md` header re-synced to the shared version (it had silently lagged); the drift test now asserts BOTH core and extended headers, and `OPERATOR.md` documents the Codex-only measurement boundary and the `@conv-*` citation-vs-adherence caveat.

## v2.9.0 — 2026-07-05 — project-convention adoption telemetry (cite-it-or-it-decays)

A project's distilled `AGENTS.md` conventions become self-measuring. `agentsmd analyze --write` stamps each recognized convention-dimension heading with a stable `@conv-<dim>` anchor (the AI's wording changes every re-run; the anchor never does) plus a citation instruction; a new fail-open Stop hook `convention-cite-scan` records a `cite` telemetry event whenever a session's own output names one of that project's known anchors; and `agentsmd analyze --adoption` reports per-dimension cite counts, flagging 0-cite dimensions as prune candidates. Advisory-only — nothing is auto-deleted — and kept structurally independent of the global `§*` enforcement/demote loop. Additive; projects with no distilled conventions see no behavior change. Revert by pinning `npm i -g @sdsrs/agentsmd@2.8.0`.

### Added
- `agentsmd analyze --write` now stamps a stable `@conv-<dim>` anchor onto each recognized convention-dimension heading (declaration style / naming / import order / error handling / request-API encapsulation / state management / comment style / git conventions — `scripts/lib/conventions-taxonomy.js`), plus a citation-instruction notice, so re-running analyze never breaks anchor continuity even though the AI's wording changes every run.
- New Stop hook `convention-cite-scan` records a `cite` telemetry event whenever a session's own output names one of a project's known `@conv-*` anchors — the adoption signal for that project's distilled conventions. Advisory, fail-open, independent of the global `§*` enforcement/demote loop.
- `agentsmd analyze --adoption [--days=N] [--project=SUBSTR]` — per-dimension cite counts and 0-cite prune candidates (advisory-only; nothing is auto-deleted from `AGENTS.md`).

## v2.8.0 — 2026-07-05 — frontend-aware project AGENTS.md

`agentsmd init` now detects a project's frontend stack (framework / meta-framework / UI library) and writes a deterministic `## Frontend` section — stack facts plus a short per-stack convention list — into the generated project `AGENTS.md`. Additive and opt-out-able; non-frontend projects are byte-unchanged. Revert by pinning `npm i -g @sdsrs/agentsmd@2.7.1`.

### Added
- `agentsmd init` now emits a deterministic `## Frontend` section for detected frontend projects (React/Vue/Svelte/Angular/Solid/Preact + meta-frameworks + UI libraries), carrying stack facts and a short per-stack convention list. `--no-frontend` opts out.

### Migration
- Frontend projects: re-running `agentsmd init` adds a `## Frontend` section inside the managed block (user content outside the sentinels is preserved). Disable with `--no-frontend`, or pin the prior release (`npm i -g @sdsrs/agentsmd@2.7.1`). Non-frontend projects are byte-unchanged.

## v2.7.1 — 2026-07-04 — cleanup + gitignore ext-globs

Maintenance. `agentsmd analyze --gather` now honors `*.<ext>` patterns from `.gitignore` (previously only bare directory names), so generated source matching a globbed extension is excluded from the AI's source map. Plus internal reporter cleanup and added characterization tests. No spec-rule change; no other command changes. Revert by pinning `npm i -g @sdsrs/agentsmd@2.7.0`.

### Changed
- `agentsmd analyze --gather` respects `*.<ext>` `.gitignore` globs, not just bare directory names.

### Internal
- Reporter readability refactor (`localHits`); added tests: self-enforced-rule `localHits` is `null` under `--project`; `injectBlockBetween` byte-stability across two blocks + user prose; dropped an unused test binding.

## v2.7.0 — 2026-07-04 — rules --project per-project activity (A-rich)

Enriches the v2.6.0 informational lens: `agentsmd rules --project=<substr>` now annotates each hook-enforced rule with `local:<n>` — its enforcement hits *within* the filtered project(s) — alongside the cross-project `hits` and verdict, with the report header labelling the columns (`hits` = cross-project, `local` = within filter). **Demote/promote verdicts remain cross-project** — a rule dead in one repo but firing in another still earns its core seat; `local:<n>` is purely informational and never changes a verdict. Purely additive. Revert by pinning `npm i -g @sdsrs/agentsmd@2.6.0`.

### Added
- `agentsmd rules --project=<substr>` — per hook-enforced rule `local:<n>` annotation (enforcement hits within the filter).

### Changed (internal, no behavior change)
- Deduplicated a project-count helper and un-shadowed a local variable in the reporter; added characterization tests (`rules` CLI empty-`--project=` rejection; `matchedSlugs` fallback).

## v2.6.0 — 2026-07-04 — project-aware telemetry (`--project`, per-project audit)

Slices the existing rule-hit telemetry loop along the `project` dimension already
stamped on every log row. Pure read-side: no new hook, no spec-rule change,
nothing new written into your repos. Establishes the per-project axis a future
project-convention telemetry layer builds on. Purely additive; every existing
command behaves as before. Revert by pinning the prior version
(`npm i -g @sdsrs/agentsmd@2.5.0`).

### Added
- `agentsmd audit --project=<substr>` — scope the per-project view to projects whose path-slug contains `<substr>` (case-insensitive), plus a new **by project** block in the report (enforcement / total, with the top firing sections per project).
- `agentsmd rules --project=<substr>` — an **informational lens**: the report shows how many projects the telemetry spans and, when filtered, which project is in view. **Demote/promote signals remain cross-project** — a rule dead in one repo but firing in another still earns its core seat; `--project` never changes a rule's verdict.

## v2.5.0 — 2026-07-04 — project convention distiller (`agentsmd-analyze`) + `init --local`

Completes the project layer: `init` (v2.4.0) writes stack *facts*; this adds the
*implicit* conventions layer — an AI distiller that reads a project's own source
— plus a personal-prefs file. Purely additive; every existing command is
unchanged. Revert by pinning the prior version (`npm i -g @sdsrs/agentsmd@2.4.0`).

### Added
- `agentsmd analyze` — distill a project's implicit coding conventions (naming, imports, error handling, comment style, git conventions) from its own source into the `AGENTS.md`'s `agentsmd:conventions` block. Deterministic gather/write (`analyze.js --gather` / `--write --from <file>`); the AI distillation step lives in the `agentsmd-analyze` skill.
- `agentsmd init --local` — scaffold a git-ignored `AGENTS.local.md` for personal preferences, idempotently added to `.gitignore`.

## v2.4.0 — 2026-07-04 — project-level AGENTS.md generator (`agentsmd init`)

Adds a project-level companion to the global spec. The global `~/.codex/AGENTS.md`
carries language-agnostic *discipline* (SPINE / Iron Laws / §8 SAFETY); the new
per-project `AGENTS.md` carries stack *facts* (detected language, package
manager, commands, structure) — Codex's discovery chain merges both layers. This
release is purely additive: every existing command behaves exactly as before, and
a project that never runs `init` is unaffected. Revert by pinning the prior
version (`npm i -g @sdsrs/agentsmd@2.3.0`).

### Added
- **`agentsmd init`** — generate or refresh a project-level `AGENTS.md` in the
  current directory. Deterministic, AI-free detection for Node / Rust / Python /
  Go reads the real manifests (`package.json`, `Cargo.toml`, `pyproject.toml`,
  `go.mod`) to fill language, runtime, package manager, monorepo layout, and
  normalized dev/build/test/lint commands. A project-scoped marker block
  (`# >>> agentsmd:project >>>` … `# <<< agentsmd:project <<<`) makes re-runs
  idempotent and preserves everything the user writes outside it. `--check`
  (exit 1 on drift, writes nothing) and `--dry-run` (print without writing)
  supported. Unlike every other subcommand, `init` targets the current project
  directory, not `$CODEX_HOME`.
- **`agentsmd-init` skill** — the command-layer stub that runs the generator from
  within a Codex session.

## v2.3.0 — 2026-07-04 — Superpowers accelerator + fix: extended spec now installs to ~/.codex/

Adds optional `superpowers`-plugin routing to the spec, and fixes an install bug
that made the entire extended spec unreachable for every user.

### Added
- `spec/AGENTS.md` §4 **Superpowers accelerator**: when the optional
  `superpowers` plugin is installed, matching task-types route to its
  `brainstorming` / `systematic-debugging` / `test-driven-development` /
  `dispatching-parallel-agents` skills — the concrete procedure for principles
  §3/§6 already mandate. Not installed → the base spec's missing-skill rule
  applies, zero impact. Codex's `[features] multi_agent = true` requirement for
  parallel agents is noted inline.
- `spec/AGENTS-extended.md` §E7 SUPERPOWERS: the `multi_agent` setup, the wider
  sp skill set, and the boundary that a skill executes this spec's rules and
  never relaxes them (Iron Laws / §5 / §8 bind inside).
- `scripts/doctor.js`: verifies `~/.codex/AGENTS-extended.md` exists and matches
  the install-dir copy — a missing/stale cat-target now surfaces instead of
  silently stripping every L3/ship/override rule. `scripts/status.js` gains an
  `extendedMdInstalled` field.

### Fixed
- **`install.js` never wrote the extended spec to its documented path.** Core
  §2/§5 order the agent to `cat ~/.codex/AGENTS-extended.md` on L3, but install
  only copied `spec/` into the install dir — the top-level cat-target never
  existed, so the whole extended spec was unreachable for every install. Install
  now writes it there (foreign-guarded — a non-agentsmd file of that name is
  never clobbered; manifest-tracked via `extendedMd` / `extendedMdAddedByUs`),
  and uninstall removes it only when it is ours.
- `spec/AGENTS-extended.md` header realigned to the shared version (was stale at
  v2.1.2; the drift test only checks the core header, so it had drifted
  unnoticed).

## v2.2.2 — 2026-07-04 — review follow-ups: docs, POSIX exit code, packaging test (no rule-text changes)

No spec RULE text changed. Follow-ups from a post-release code review of the
v2.2.0/2.2.1 npm CLI.

### Fixed
- `bin/agentsmd.js`: a subcommand killed by a signal now exits `128 + signum`
  (e.g. SIGINT → 130) instead of a flat `1`, per POSIX convention.
- README (EN + 中文): the `--ref` curl example pins `v2.2.1` (was `v2.2.0`).

### Added
- `scripts/tests/distribution.test.js`: a packaging E2E test — `npm pack` +
  global install into a sandbox prefix, then run the linked bin — covering the
  bin-resolution / packaging class that direct `node bin/agentsmd.js` tests
  cannot reach (the failure behind v2.2.1). The bare-npx regression guard also
  now tolerates flags between `npx` and the scoped name (e.g. `npx -y …`).
- `ARCHITECTURE.md`: documents `bin/` as the npm CLI entry that spawns (never
  imports) the L2 scripts, upholding the layer-isolation invariant.

## v2.2.1 — 2026-07-03 — docs: npm install guidance (no rule-text changes)

No spec RULE text changed. No package code changed from v2.2.0 — the `agentsmd`
CLI is byte-identical; this is a docs-only correction.

### Fixed
- README (EN + 中文) now leads with the global install
  (`npm install -g @sdsrs/agentsmd` then `agentsmd install`), which links the
  `agentsmd` bin consistently. The bare `npx @sdsrs/agentsmd <command>` form
  shown in v2.2.0 is unreliable for this scoped package on npm 11.x (intermittent
  `agentsmd: not found` from npx's command resolution — the package itself is
  unaffected; `npm install` links the bin every time). The documented one-shot
  is now `npx --package @sdsrs/agentsmd agentsmd <command>`.
- `scripts/tests/distribution.test.js` guards against reintroducing the bare-npx
  form in either README.

## v2.2.0 — 2026-07-03 — npm CLI (`npx @sdsrs/agentsmd`) (no rule-text changes)

No spec RULE text changed.

### Added
- **`agentsmd` npm CLI** (`bin/agentsmd.js`): the package now ships a CLI, so npm
  users no longer need `npm explore -g @sdsrs/agentsmd -- node scripts/install.js`.
  - `npx @sdsrs/agentsmd install` runs a one-shot install with nothing left
    globally; `npm install -g @sdsrs/agentsmd` then exposes `agentsmd
    install | update | uninstall | status | doctor | audit | rules`.
  - The CLI is a thin dispatcher that spawns the existing `scripts/*.js`, so each
    script's argument parsing, JSON output, and exit code pass through unchanged
    (`audit`/`rules` still take `--days=N`).
  - A bare `agentsmd` / `npx @sdsrs/agentsmd` prints help and installs nothing — a
    bare `npx` run never silently writes to `$CODEX_HOME`.
- `package.json` now carries `repository`, `homepage`, and `bugs` metadata and
  ships `bin/`.

### Changed
- README (EN + 中文): the npm sections use `npx` / the `agentsmd` CLI instead of
  `npm explore`; the plugin section now states that plugin install wires **hooks
  only** — the spec block, `[features] hooks = true`, and codexmd migration come
  from the script installer (`npx @sdsrs/agentsmd install`).

### Migration
- Additive and backward-compatible. The old `npm explore -g @sdsrs/agentsmd --
  node scripts/install.js` path still works. To adopt the CLI, upgrade with
  `npm install -g @sdsrs/agentsmd@latest`. Pin `@sdsrs/agentsmd@2.1.2` to stay on
  the previous release.

## v2.1.2 — 2026-07-03 — QA hardening (no rule-text changes)

No spec RULE text changed.

### Added
- Installer restores the useful Codex built-in TUI footer preset formerly provided
  by oh-my-codex: `[tui] status_line = ["model-with-reasoning", "git-branch",
  "context-remaining", "total-input-tokens", "total-output-tokens",
  "five-hour-limit", "weekly-limit"]`. Existing user-defined `status_line`
  values are preserved byte-for-byte.
- `status` now reports `tuiStatusLineConfigured` and
  `agentsmdStatusLinePreset`; `doctor` reports whether `tui.status_line` is
  configured.

### Fixed
- Ship gates now block red-CI pushes using `HEAD:refs/heads/<branch>` refspecs
  and `--push-option` / `-o` before the remote name.
- Stop-time advisories are scoped by Codex `session_id`, so one Codex session
  cannot surface and clear another session's queued advisory.
- Memory-read ship checks no longer treat user prompt text mentioning
  `MEMORY.md` as evidence that the file was consulted, and memory lookup now
  covers non-git parent directories.
- PreTool safety checks catch more remote-exec shell variants such as
  `curl | env bash`, path-qualified interpreters, `zsh`, `dash`, `ksh`, and
  `fish`.
- Banned-vocabulary checks now inspect Git commit message variants such as
  `git commit -am`, `git commit -sm`, and `git commit -m"..."`.
- `audit`, `rules`, `status`, and `doctor` reject invalid CLI arguments instead
  of silently falling back; `audit`/`rules` also reject oversized and duplicate
  `--days` values.
- `status.telemetryRows` now counts parseable telemetry rows using the same
  JSONL parser as `audit`, instead of counting malformed non-empty log lines.
- `audit --days=N` excludes parseable future timestamps while keeping the exact
  cutoff timestamp in the window.
- `doctor` now fails on unparseable `tui.status_line` values but accepts valid
  custom TOML arrays, including single-quoted strings, multiline arrays, and
  comments outside strings.
- The jq-less telemetry fallback now escapes JSON string fields correctly.
- `transcript-structure-scan` ignores banned vocabulary inside fenced code
  blocks.
- `install.sh` now cleans its temp source directory on early repo validation
  failures, including custom `TMPDIR` paths.

### Testing
- Added sandbox install coverage for fresh status-line installation, existing
  `[tui]` tables, custom user status lines, and `install.sh --status` reporting.
- Added regression coverage across ship parsing, advisory scoping, memory
  gates, PreTool command variants, CLI validation, telemetry parsing, transcript
  scans, and installer cleanup. Full release suite: install 79, audit 17, drift
  8, distribution 7, hook smoke 59 checks.

## v2.1.1 — 2026-07-03 — npm scoped package publish (no rule-text changes)

No spec RULE text changed.

### Changed
- npm package name is now `@sdsrs/agentsmd`. npm rejected the unscoped `agentsmd`
  package name as too similar to the existing `agents-md` package, so the publishable
  npm artifact moved under the maintainer scope. The Codex plugin name, marketplace
  name, GitHub repository, install directory, hooks, skills, and user-facing command
  names remain `agentsmd`.

## v2.1.0 — 2026-07-03 — distribution install surfaces (no rule-text changes)

The published artifact now has first-class install paths for both standalone users
and Codex plugin marketplace users. No spec RULE text changed.

### Added
- Root `install.sh` for curl-friendly standalone install/update/status/doctor/uninstall.
  The script fetches a GitHub snapshot by default, supports `--ref` pinning and local
  `--source` development installs, checks for Node.js >= 18, and removes its temporary
  download directory on exit.
- Repo marketplace metadata at `.agents/plugins/marketplace.json`, exposing the root
  `agentsmd` plugin for `codex plugin add agentsmd --marketplace agentsmd`.
- README install/update/uninstall flows for standalone curl installs and Codex plugin
  marketplace installs, including cleanup commands for both surfaces.

### Testing
- Added distribution tests for `install.sh` syntax/help/local install-update-uninstall,
  marketplace metadata, and package-file inclusion.

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
