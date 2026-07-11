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

Plugin and standalone are alternative installation surfaces; choose one. When a complete standalone install is detected, plugin hooks exit to avoid duplicate execution. `status` and `doctor` still report `dualSurface: true` so you can remove one surface.

### Full standalone installation

This idempotent installer manages the global spec, native hook configuration, status-line default, migration, and standalone lifecycle under `$CODEX_HOME` (default: `~/.codex`). Download, inspect, then run it:

```bash
curl -fsSLo /tmp/agentsmd-install.sh https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh
less /tmp/agentsmd-install.sh
sh /tmp/agentsmd-install.sh
```

To pin a branch, tag, or commit, pass `--ref`; this historical tag is only an example:

```bash
sh /tmp/agentsmd-install.sh --ref v2.2.1
```

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

`init` detects Node, Rust, Python, Go, package-manager commands, and common frontend stacks. It updates a sentinel-managed block while preserving content outside it.

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

`analyze --gather` creates a capped, ignore-aware source map. The AI-assisted skill distills naming, imports, errors, and comments; `--write --from` writes the reviewed result to the managed conventions block. The command refuses content beyond the 6 KiB convention budget instead of truncating it.

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

`design` previews facts from CSS `:root` variables and Tailwind v4 `@theme`; `design --write` creates a managed `DESIGN.md` block and an `AGENTS.md` pointer. Non-frontend projects are a no-op. Tailwind v3 configuration objects are identified but not parsed.

## CLI reference

| Command | Purpose |
|---|---|
| `install`, `update`, `uninstall` | Manage the standalone installation |
| `status`, `doctor`, `restore` | Inspect health or restore a pre-install snapshot (`restore` is dry-run without `--confirm`) |
| `init`, `analyze`, `design` | Maintain project guidance and design facts |
| `audit`, `rules`, `sparkline` | Review rule activity and governance signals |
| `sampling-audit`, `lesson-bypass-audit` | Measure transcript compliance and memory-hint follow-through |
| `safety-coverage-audit`, `lint-argv` | Check static safety wiring and strict CLI argument parsing |
| `perf-baseline`, `version-cascade` | Measure hook cost and detect stale README version prose |

Run `agentsmd --help` for the current option list. All commands honor `$CODEX_HOME` except `init`, `analyze`, and `design`, which operate on the current project.

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

# uninstall the Codex footprint, then the optional global CLI
agentsmd uninstall
npm uninstall -g @sdsrs/agentsmd
```

The curl installer exposes the same lifecycle through `--update`, `--status`, `--doctor`, and `--uninstall`. If both plugin and standalone surfaces are installed, remove both separately.

## Safety, ownership, and coexistence

Standalone installation is manifest-backed and marker-scoped. It preserves other hook tenants and user content outside agentsmd-managed blocks, validates owned artifacts before mutation, and refuses unparseable shared files or hash-mismatched owned files. Install, uninstall, and restore use staged changes, snapshot checks, write-time compare-and-swap, and rollback. A non-cooperating writer causes refusal instead of silently overwriting changed shared files.

Uninstall removes registered hooks, skills, the managed `AGENTS.md` block, known runtime state, and the extended spec. It retains recovery backups, unknown state, telemetry, enabled hook/status-line settings, and unregistered no-op shims needed by already-running sessions.

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
