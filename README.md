# agentsmd — Coding Discipline and Native Hooks for OpenAI Codex CLI

**English · [中文](./README.zh-CN.md)**

agentsmd is an `AGENTS.md` coding specification and native-hooks plugin for OpenAI Codex CLI. It provides an evidence-driven workflow, 15 bounded safety and reporting checks, project-aware instruction tools, and telemetry for human rule review.

![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![hooks](https://img.shields.io/badge/Codex_hooks-15-blue)

- **Evidence-driven workflow:** classify work, check authorization, plan, execute, validate, and report with fresh evidence.
- **Bounded native checks:** block selected detectable risks and surface structured advisories without claiming to automate every semantic rule.
- **Project-aware tooling:** generate `AGENTS.md`, distill coding conventions, and extract frontend design tokens.

## Install

### Codex plugin — recommended

Install agentsmd from its Codex marketplace:

```bash
codex plugin marketplace add sdsrss/agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json
```

The shorter second command is also supported:

```bash
codex plugin add agentsmd@agentsmd
```

Then start a new Codex session so the packaged hooks and skills are loaded. To verify:

```bash
codex plugin list --marketplace agentsmd --json
```

Codex asks you to review trust before plugin hooks run for the first time. Inspect the `hooks.json` selected by `.codex-plugin/plugin.json` and its 15 local commands before approving it. Until hooks are trusted, skills may be visible, but the spec banner and runtime checks do not execute.

Prefer the UI? Open **Plugins** in the Codex app, or run `codex`, enter `/plugins`, open the `agentsmd` marketplace entry, and select **Install plugin**.

> The plugin bundle provides hooks, skills, and the specification through Codex's plugin cache. A trusted `SessionStart` hook adds the packaged core spec to the current session and announces the actual extended-spec path. It does not rewrite `~/.codex/AGENTS.md`, enable `[features] hooks = true`, or migrate a previous `codexmd` installation. Use standalone/npm when you need global files and the full lifecycle.

Plugin and standalone are alternative installation surfaces; choose one. In a dual-surface process, agentsmd evaluates manifest-backed standalone integrity before SemVer precedence: a healthy same/newer standalone wins and protocol-v1 plugin hooks yield; an absent, malformed, damaged, disabled, miswired, content-divergent, or older standalone cannot hide a healthy plugin. `status` adds `selectedSurface` and a stable `surfaceArbitration` record without changing the existing standalone fields. `doctor` keeps every manifest-backed dual surface red as an operational cleanup requirement, even when protocol-v1 fixtures prove one hook copy yields. A new plugin cannot disable commands or remove global core context already loaded from an older standalone, so its logical selection adds the packaged core but does not prove sole policy/hook execution; update/uninstall that standalone to remove the non-cooperative boundary.

### Full standalone installation

This idempotent installer manages the global spec, native hook configuration, status-line default, migration, and standalone lifecycle under `$CODEX_HOME` (default: `~/.codex`). Download, inspect, then run it:

```bash
curl -fsSLo /tmp/agentsmd-install.sh https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh
less /tmp/agentsmd-install.sh
sh /tmp/agentsmd-install.sh
```

By default the installer resolves its **own release tag** to the immutable GitHub
release asset and verifies the published SHA-256 **before** executing anything
from it. `--ref vX.Y.Z` pins another release tag (also verified); a 40-hex
commit is immutable by identity but has no published checksum and warns; a
mutable branch such as `main` is refused unless you add `--dev` (development
only — nothing is pinned or verified on that path).

Prerequisites (`jq`, Node.js 18+) are checked **before any file changes**: a
miss aborts with zero mutation. `--degraded` is the explicit opt-in for a
non-enforcing install (hooks fail open); the manifest records
`enforcement:false` and `status`/`doctor` keep warning until a healthy
`agentsmd update`.

Mutating lifecycle operations (install / update / uninstall / `restore
--confirm` / `repair --confirm`) are serialized per `$CODEX_HOME` by a
cross-process lock: a concurrent second operation refuses with exit 1 and
changes nothing, naming the one in flight. A lock left by a crashed run
self-clears on the next lifecycle command; `doctor` reports stale locks.
Each commit is also journaled before the first live mutation, so a run
killed mid-commit is adjudicated from disk and **recovered by the next
lifecycle command**: it rolls the crashed transaction forward when every
staged source survives, back otherwise, then proceeds — every crash point
heals with a plain re-run. Only a foreign concurrent change on a journaled
target stays fail-closed (bytes preserved; `doctor` prints the verdict and
the exact recovery command).

### npm CLI

Install a versioned CLI globally, then run the same standalone lifecycle:

```bash
npm install -g @sdsrs/agentsmd
agentsmd install
agentsmd doctor
```

One-shot form without a global CLI:

```bash
npx --package @sdsrs/agentsmd agentsmd install
```

A bare `agentsmd` prints help and writes nothing. Exit codes are consistent: `0` = success/help, `1` = negative result or runtime failure, `2` = argv/usage error.

Since v4.19.0 every npm version is published from CI with a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) (Sigstore / SLSA) binding the package to this repository and tag; verify it with `npm audit signatures`.

### From a local checkout

For contributors and installation review:

```bash
node scripts/install.js
node scripts/status.js
node scripts/doctor.js
```

## Requirements

- OpenAI Codex CLI with native hooks support, plus an available `bash`.
- Node.js 18 or newer and `jq` on `PATH`; Git workflows also require `git`.
- Standalone installs enable `[features] hooks = true`; plugin installs rely on the Codex plugin runtime.
- GitHub-aware shared-branch checks optionally use `gh`.
- Automation covers Linux and macOS; on Windows, run the Bash hooks under WSL.

Hooks fail open when required input or prerequisites cannot be evaluated, and record the failure when possible.

## What agentsmd does

The always-on core and triggered extended spec define this workflow:

```text
CLASSIFY → AUTH → ROUTE → PLAN → EXECUTE → VALIDATE → REPORT
```

The system adds:

- level-based validation and fresh-evidence requirements;
- authorization gates for destructive or externally visible actions;
- an immutable safety floor for secrets, unsafe deletion, and remote execution;
- ordered, evidence-backed task reports;
- native checks for the mechanically detectable subset of the spec;
- rule-specific opportunity and outcome telemetry for operator review;
- 15 Codex skills that route reusable diagnostics and project workflows.

An explicit request to commit and release or publish authorizes the standard ship flow for the named repository/package. Unnamed production, live configuration, or unrelated scopes remain outside that authorization.

## How it works

| Layer | Role | Main artifacts |
|---|---|---|
| Specification | Defines workflow, authorization, evidence, safety, and reporting | `spec/AGENTS.md`, `spec/AGENTS-extended.md` |
| Native hooks | Blocks or observes selected detectable patterns across four Codex events | `hooks/*.sh`, `hooks.json` |
| Management | Installs, diagnoses, restores, audits, and governs | `scripts/*.js`, `agentsmd` CLI |
| Project tools | Generates project facts, conventions, and design-token references | `agentsmd init`, `analyze`, `design` |

Stop-time observers queue advisories. Those advisories appear on the next `UserPromptSubmit`, rather than being emitted inline during `Stop`. Telemetry is appended to `$CODEX_HOME/logs/agentsmd.jsonl`.

## Native hook coverage

agentsmd registers 15 hooks across `SessionStart`, `PreToolUse`, `UserPromptSubmit`, and `Stop`. Blocking hooks are narrow mechanical gates; semantic rules remain agent/operator responsibilities.

| Hook | Event | Detectable responsibility |
|---|---|---|
| `pre-bash-safety-check` | PreToolUse:Bash | Detects direct/indirect variable deletes and remote files executed after copy or move; warns on unpinned `npx` |
| `banned-vocab-check` | PreToolUse:Bash | Blocks unquantified value claims in `git commit` messages |
| `ship-baseline-check` | PreToolUse:Bash | Blocks a shared-branch push when its CI baseline is known red |
| `memory-read-check` | PreToolUse:Bash | Requires the project index and canonical, same-repository linked-memory reads before shipping |
| `secrets-scan` | PreToolUse:Bash | Blocks commits with detected secrets or high-confidence secret filenames |
| `session-start-check` | SessionStart | Injects the active-spec banner and resets the advisory queue |
| `surface-advisories` | UserPromptSubmit | Surfaces advisories queued by the previous turn |
| `memory-prompt-hint` | UserPromptSubmit | Surfaces prompt-matched `MEMORY.md` entries |
| `residue-audit` | Stop | Flags growth in task residue under Codex temporary storage |
| `sandbox-disposal-check` | Stop | Flags likely task scratch while excluding runtime-owned paths |
| `transcript-structure-scan` | Stop | Checks §10 report structure and vocabulary plus §6 evidence anchors |
| `convention-cite-scan` | Stop | Records valid `@conv-*` project-convention citations |
| `session-exit-checkpoint` | Stop | Flags changed bytes without later test/lint/typecheck/build evidence |
| `mem-audit` | Stop | Checks memory index/file drift and verified headers |
| `session-summary` | Stop | Stores a rolling enforcement tally for explicit `status` inspection; never injects it into another session |

## Project workflows

### Generate a project `AGENTS.md`

Run in the project root:

```bash
agentsmd init
```

`init` detects Node, Rust, Python, Go, package-manager commands, and common frontend stacks. A repo hosting several ecosystems reports every manifest-verified stack (a `Stacks:` line plus per-runtime-labeled commands); commands are asserted only from manifest/script evidence — an undeclared test runner is omitted, never guessed. It updates a sentinel-managed block while preserving content outside it.

- `--check` reports drift.
- `--dry-run` previews without writing.
- `--local` creates a git-ignored, create-only `AGENTS.local.md` and prints the Codex fallback setting needed to load it.
- `--no-frontend` skips React/Vue/Svelte/Angular/Solid/Preact and related framework facts.

`--check`, `--dry-run`, and `--local` are mutually exclusive execution modes.

### Distill coding conventions

```bash
agentsmd analyze --gather
agentsmd analyze --write --from conventions.md
```

`analyze --gather` creates a capped, ignore-aware source map, sampled round-robin across (top-level directory × language) strata so one large directory cannot crowd out the rest of a multi-language repo; an oversize file is skipped and counted, never a reason to stop sampling. The AI-assisted skill distills naming, imports, errors, and comments; `--write --from` writes the reviewed result to the managed conventions block. The command refuses content beyond the 6 KiB convention budget instead of truncating it.

Track whether known convention anchors are cited:

```bash
agentsmd analyze --adoption
agentsmd analyze --adoption --days=7 --project=X
```

Zero citations trigger manual review, not automatic deletion; per-anchor evaluated opportunities are not recorded yet.

### Extract design tokens

```bash
agentsmd design
agentsmd design --write
```

`design` previews facts from CSS `:root` variables and Tailwind v4 `@theme`; `design --write` creates a managed `DESIGN.md` block and an `AGENTS.md` pointer. Non-frontend projects are a no-op. Tailwind v3 configuration objects are identified but not parsed. Conflicting cross-file definitions of one token are reported as ambiguous with each candidate's source and selector — the effective value depends on CSS import order, which a static scan cannot see, so it is never guessed; per-selector theme variants (e.g. `:root[data-theme="dark"]`) are reported per context.

## CLI reference

| Command | Purpose |
|---|---|
| `install`, `update`, `uninstall` | Manage the standalone installation |
| `status`, `doctor`, `repair`, `restore` | Inspect health, repair missing manifest-owned artifacts, or restore a shared-file snapshot |
| `init`, `analyze`, `design` | Maintain project guidance and design facts |
| `exception` | Register reviewed §8 false-positive exceptions in the repo's `.agentsmd/exceptions.json` (fingerprint + expiry; replaces the removed inline `[allow-*]` tokens) |
| `audit`, `rules`, `sparkline` | Review rule activity and governance signals |
| `sampling-audit`, `lesson-bypass-audit` | Measure transcript compliance and memory-hint follow-through |
| `safety-coverage-audit`, `lint-argv` | Check static safety wiring and strict CLI argument parsing |
| `perf-baseline`, `version-cascade` | Measure hook cost and detect stale README version prose |

Run `agentsmd --help` for the current option list. All commands honor `$CODEX_HOME` except `init`, `analyze`, `design`, and `exception`, which operate on the current project.

## Update, verify, and uninstall

### Codex plugin

```bash
# update
codex plugin marketplace upgrade agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json

# uninstall
codex plugin remove agentsmd --marketplace agentsmd --json
codex plugin marketplace remove agentsmd --json
```

Start a new Codex session after a plugin update and review any changed hook commands again.

### Standalone or npm

```bash
# update and verify
agentsmd update
agentsmd status
agentsmd doctor

# damaged standalone: review a read-only plan, then bind apply to its digest
agentsmd repair --plan
agentsmd repair --confirm=<planDigest>

# uninstall the Codex footprint, then the optional global CLI
agentsmd uninstall
npm uninstall -g @sdsrs/agentsmd
```

The curl installer exposes install/update/status/doctor/uninstall. `repair` requires a
versioned npm CLI or reviewed local checkout so the replacement artifact can be
identified before mutation. If both plugin and standalone surfaces are installed,
remove both separately.

Plugin context is accepted only from Codex's runtime `CLAUDE_PLUGIN_ROOT` or the
root resolved by the status/doctor skill (`AGENTSMD_PLUGIN_ROOT`). The CLI does not
scan plugin caches, because a cached artifact does not prove that Codex enabled it.
When context is available, `surfaceArbitration` reports both candidates' version,
health evidence, the selected surface, a stable reason code, and whether exclusive
execution is supported by the static cooperation protocol. That field is not
runtime exact-once proof; the real Codex E2E gate remains separate. Selection is
not a trust boundary: plugin integrity remains
structural until immutable artifact provenance is implemented.
The legacy top-level `dualSurface` field retains its manifest-presence meaning for
JSON compatibility; manifest-less partial footprints appear in
`surfaceArbitration.candidates.standalone`. Doctor's legacy `surface` field remains
the diagnostic invocation context, while `selectedSurface` is the logical winner.

## Safety, ownership, and coexistence

Standalone installation is manifest-backed and marker-scoped. It preserves other hook tenants and user content outside agentsmd-managed blocks, validates owned artifacts before mutation, and refuses unparseable shared files or hash-mismatched owned files. Install and uninstall use staged changes, snapshot checks, write-time compare-and-swap, and rollback. A non-cooperating writer causes refusal instead of silently overwriting changed shared files.

`repair --plan` is read-only. It distinguishes an intact update path from missing
manifest-owned files and from states where ownership cannot be proved. Automatic
repair is deliberately limited to missing files/directories under a valid exact-path
manifest and requires a source artifact whose version and deploy digest exactly match
that manifest; modified bytes, unexpected files, malformed manifests, and manifest-less
partial installs remain blocked for manual review. `--confirm=<planDigest>` rechecks
the source and live descriptors, saves deploy/skills/extended/manifest plus shared
files in a full pre-repair snapshot, then reuses the installer transaction. The
digest becomes stale if the artifact or any target/shared file changes.

`restore` is different: its historical pre-install backups contain only
`hooks.json`, `config.toml`, and `AGENTS.md`. It cannot repair deploy, skills,
the extended spec, or the ownership manifest.

Uninstall removes registered hooks, skills, the managed `AGENTS.md` block, known runtime state, the extended spec, and the status-line preset it added — a status line you have since customized is left untouched. It retains recovery backups, unknown state, telemetry, the enabled hook flag (removing it could break other tenants' hooks), and unregistered no-op shims needed by already-running sessions.

agentsmd is independent of oh-my-codex. If OMX is present, agentsmd treats its entries as another tenant and leaves them intact.

If upgrading from `codexmd` v1.4.0–v1.4.3, the standalone installer migrates only artifacts with verifiable legacy provenance. The project was renamed to agentsmd in v2.0.0.

## Governance and telemetry

```bash
agentsmd audit --days=30
node scripts/audit.js --project=X
agentsmd rules --days=30
agentsmd sparkline --windows=6 --bucket-days=7
```

A rule becomes a demotion candidate only after enough rule-specific evaluated opportunities with zero enforcement hits. `--project` is an informational lens; demotion remains cross-project. `no-opportunity`, low evaluation counts, and global session counts are not demotion evidence. High hit counts show activity, not correctness. The operator makes the decision using [`spec/OPERATOR.md`](./spec/OPERATOR.md).

## Security and privacy

See [`SECURITY.md`](./SECURITY.md) for the vulnerability-reporting channel and response targets, supported versions, the threat model, and the telemetry schema/retention/deletion/opt-out reference. The one-paragraph version: agentsmd is a **fail-open coding-discipline layer, not a security boundary**; telemetry is local-only (`~/.codex/logs/agentsmd.jsonl`, private file modes, size-capped rotation, `DISABLE_RULE_HITS_LOG=1` to opt out, delete the file to erase). Note for dual-surface installs: skills load outside surface arbitration, so plugin + standalone simultaneously means duplicated skills in the session — install one surface only; `doctor` flags it.

## Development

```bash
npm test
npm run lint:shell
```

The test suite covers installation isolation, plugin distribution, hook wiring, drift, telemetry, diagnostics, project workflows, and shell smoke fixtures. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for design boundaries and [`CHANGELOG.md`](./CHANGELOG.md) for releases.

```text
bin/          npm CLI dispatcher
spec/         core, extended spec, hard-rule manifest, operator guide
hooks/        native hooks, shared shell libraries, smoke tests
scripts/      lifecycle, diagnostics, governance, project tools, tests
skills/       15 Codex skill routers
.agents/      Codex marketplace metadata
.codex-plugin/plugin.json
hooks.json    plugin-root hook wiring
install.sh    standalone installer and lifecycle wrapper
```

## FAQ

### Is agentsmd an `AGENTS.md` template?

It is more than a template. agentsmd combines a global coding specification, bounded native checks, project tools, diagnostics, and rule-review telemetry.

### Does the Codex plugin install the global specification?

No. The plugin installs hooks and skills into the Codex plugin cache. Run `agentsmd install` or the standalone installer when you also want the managed global `AGENTS.md` block and standalone configuration lifecycle.

### Does agentsmd require oh-my-codex?

No. agentsmd installs independently and preserves other tenants when they are present.

### Does agentsmd replace human review?

No. Hooks cover selected detectable patterns. Semantic authorization, correctness, and rule promotion or demotion remain evidence-based agent/operator decisions.

## License

MIT
