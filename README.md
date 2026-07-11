# agentsmd

**English · [中文](./README.zh-CN.md)**

> A coding-discipline spec for **OpenAI's Codex CLI**, with native hooks for selected mechanically detectable rules and telemetry for measured review. It installs standalone and is independent of oh-my-codex.

![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![hooks](https://img.shields.io/badge/hooks-native%20Codex-blue) ![independent](https://img.shields.io/badge/independent%20of-oh--my--codex-orange)

> **Formerly `codexmd`.** The project was renamed to `agentsmd` in v2.0.0 to match its repository. The installer migrates prior artifacts only when their legacy provenance can be verified — [details below](#upgrading-from-codexmd).

---

## What is agentsmd?

**agentsmd is a global coding-discipline spec for the Codex CLI with a mechanically observed subset.** The spec — `spec/AGENTS.md` (always-on core) plus `spec/AGENTS-extended.md` (triggered detail) — defines a `CLASSIFY → AUTH → ROUTE → PLAN → EXECUTE → VALIDATE → REPORT` workflow, level-based evidence, Iron Laws, a §8 SAFETY floor, and ordered reporting. Enabled hooks block or advise on patterns they can detect; semantic rules remain agent/operator enforced.

## Why hooks and telemetry, not just an `AGENTS.md`?

A spec file is only as strong as the model's willingness to follow it mid-session. The real cost of a long rule list is **attention dilution**: the more rules you write, the weaker each one's pull in the middle of a long task — and that cost is invisible to any token count.

agentsmd answers this the way a system does, not a document:

- **Hooks** block selected command shapes such as unvalidated recursive deletes, detected secrets, and known-red shared-branch pushes. Hooks are bounded and fail-open when prerequisites or parsing are unavailable; those failures are recorded when possible.
- **Telemetry** separates eligible/evaluated opportunities from enforcement hits, so `agentsmd-rules` can reject no-opportunity windows instead of treating every raw zero as dilution.

The point is not a raw token count. Core size, detector coverage, opportunity rows, and outcomes are separate signals; the operator reviews them together before changing an always-on rule.

## What it enforces

Fifteen native hooks across four Codex events (SessionStart, PreToolUse, UserPromptSubmit, Stop — no PostToolUse). The blocking ones are hard gates; the Stop-time ones queue an advisory that surfaces at your next prompt.

An explicit request to commit and release/publish authorizes that standard ship
flow without a second confirmation. Completion includes default-branch
integration, tag/artifact verification, and deletion of merged task/release
branches locally and remotely. Unnamed production, live configuration, or other
repository/package/registry scopes remain outside that authorization.

| Hook | Event | Enforces |
|---|---|---|
| `pre-bash-safety-check` | PreToolUse:Bash | §8 SAFETY — blocks unsafe variable deletes and same/cross-tool execution of remote downloads, including relative and nested-shell provenance; warns on unpinned `npx` |
| `banned-vocab-check` | PreToolUse:Bash | §10 — blocks unquantified value claims in `git commit` messages |
| `ship-baseline-check` | PreToolUse:Bash | §E3 — blocks `git push` to a shared branch while its CI is red |
| `memory-read-check` | PreToolUse:Bash | §7 — blocks a ship without a successful `read_file` or explicit read command for the project memory index + a linked memory |
| `secrets-scan` | PreToolUse:Bash | §8 — blocks commits adding secret content or high-confidence `.env`/private-key filenames |
| `session-start-check` | SessionStart | injects the active-spec banner; resets the advisory queue |
| `surface-advisories` | UserPromptSubmit | surfaces advisories the Stop hooks queued last turn |
| `memory-prompt-hint` | UserPromptSubmit | surfaces `MEMORY.md` entries matching the prompt |
| `residue-audit` | Stop | §7/§9 — flags `~/.codex/tmp` growth |
| `sandbox-disposal-check` | Stop | §8.V4 — flags likely task scratch, excludes Codex runtime paths, and requires ownership verification before deletion |
| `transcript-structure-scan` | Stop | §10/§6 — checks report-label completeness/order, vocabulary, fix-evidence anchors, and Uncertain phrasing |
| `convention-cite-scan` | Stop | tracks `@conv-*` project-convention citations for `analyze --adoption` |
| `session-exit-checkpoint` | Stop | §7 — tracks patch/formatter mutations and flags bytes left without test/lint/typecheck/build evidence |
| `mem-audit` | Stop | §7 — flags `MEMORY.md` index/file drift + missing verified headers |
| `session-summary` | Stop | records the session's enforcement tally (surfaced next SessionStart) |

Stop-hook advisories are queued and surfaced at the next `UserPromptSubmit` (the verified `additionalContext` channel), not emitted inline on Stop. Every hit is appended to `~/.codex/logs/agentsmd.jsonl`.

## Requirements

- **Codex CLI** with native hooks enabled — `config.toml` → `[features] hooks = true`. The installer sets this and migrates the pre-0.142 `codex_hooks` name automatically. It also restores a useful built-in TUI footer with `[tui] status_line` when the user has not already configured one.
- **`jq`** and **`node` ≥ 18** on `PATH`.

Installed artifacts, runtime state, logs, and standalone lifecycle commands honor
`$CODEX_HOME` (defaults to `~/.codex`). Project commands such as `init`,
`analyze`, and `design` operate on the current working directory; Codex manages
its own plugin cache.

## Install

Choose one install surface:

- **Standalone curl installer:** shortest path for most local Codex CLI users.
- **npm package:** a version-pinned global `agentsmd` CLI (`npm install -g
  @sdsrs/agentsmd`), or a one-shot via `npx --package`.
- **Codex plugin marketplace:** use Codex's plugin browser; newer CLIs also
  expose automation commands.
- **Local checkout:** for development or reviewing changes before installing.

### Standalone installer

Use this when you want agentsmd to manage its own manifest-backed artifacts and marker-scoped shared entries in
`$CODEX_HOME` directly. The installer downloads the latest repo snapshot, runs
the same idempotent Node installer used by local development, and cleans up its
temporary files when it exits.

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh
```

GitHub does not serve raw file contents from
`https://github.com/sdsrss/agentsmd/install.sh`; use the `raw.githubusercontent.com`
URL above for a curl-piped install.

Useful options:

```bash
# pin a branch, tag, or commit
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --ref v2.2.1

# explicit update: same operation as install, safe to re-run
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --update

# health checks after install
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --status
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --doctor
```

If your local policy blocks `curl | sh`, use the inspectable two-step form:

```bash
curl -fsSLo /tmp/agentsmd-install.sh https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh
sh /tmp/agentsmd-install.sh
```

### npm package

The package ships an `agentsmd` CLI, so npm users no longer need `npm explore`.
It is scoped as `@sdsrs/agentsmd` because npm rejected the unscoped `agentsmd`
name as too similar to an existing package; the installed Codex footprint still
uses the `agentsmd` name.

Install the CLI globally and call it directly:

```bash
npm install -g @sdsrs/agentsmd
agentsmd install     # then: update, uninstall, status, doctor, audit, rules
```

Prefer a one-shot with nothing installed globally? Run it through `npx` with an
**explicit command name** — a scoped package needs the command spelled out, so
`npx --package … agentsmd …`, not a bare `npx @sdsrs/agentsmd …` (which some
npm/npx versions fail to resolve):

```bash
npx --package @sdsrs/agentsmd agentsmd install
```

`agentsmd --help` is the authoritative list of project, lifecycle, diagnostic,
and governance subcommands. A bare `agentsmd` prints that help and installs
nothing. `install` and `update` print a concise result by default; pass `--json`
when automation needs the full install manifest.

CLI exit codes are consistent across subcommands: `0` means success/help, `1`
means a valid command reported a negative or runtime result, and `2` means an
argv/usage error.

### Codex plugin marketplace

Use this when you want Codex to install agentsmd as a plugin and keep the bundle
in Codex's plugin cache. The repo ships a marketplace at
`.agents/plugins/marketplace.json`; its marketplace name is `agentsmd`, and the
entry pins the published `@sdsrs/agentsmd` npm artifact instead of treating the
entire repository checkout as the plugin payload.

> **What the plugin bundle declares — and what the repository verifies.** The
> bundle declares agentsmd's **hooks** and skills. Repository drift tests verify
> that bundle wiring matches the standalone template, but they do not exercise
> every Codex plugin runtime/version end to end. The rest of a full install —
> injecting the core spec into `~/.codex/AGENTS.md`, setting `config.toml`
> `[features] hooks = true`, and migrating a prior codexmd install — is done by
> the standalone script. Run it once after adding the plugin when you need that
> repository-tested surface:
>
> ```bash
> npm install -g @sdsrs/agentsmd && agentsmd install
> ```

The general Codex plugin install flow is the plugin browser:

- In the Codex app, open **Plugins**, browse the marketplace, and select **Add
  to Codex**.
- In Codex CLI, run `codex`, enter `/plugins`, open the marketplace entry, and
  select `Install plugin`.

For automation, newer Codex CLIs expose the experimental `codex plugin`
commands:

```bash
codex plugin marketplace add sdsrss/agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json
```

Codex also accepts `codex plugin add agentsmd@agentsmd`. The `--marketplace`
form is clearer in scripts and matches the documented CLI reference. If your
local `codex --help` does not list `plugin`, update Codex, install through the
plugin browser, or use the standalone/npm installer above.

### Local development checkout

```bash
node scripts/install.js     # merge into ~/.codex, set hooks + status_line, inject the spec block
node scripts/status.js      # confirm: agentsmd hooks registered, other tenants preserved
node scripts/doctor.js      # health checks
```

Install is **idempotent** and preserves every other tenant's hook objects; the install/uninstall round trip restores the seeded shared fixture byte-for-byte.

## Update

Standalone updates are automatic on re-run: the curl installer fetches the
current repo snapshot, refreshes agentsmd's files, re-merges its hooks without
duplication, and picks up any new spec.

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --update

# from a checkout:
node scripts/install.js     # = update (idempotent); or: npm run spec:update
```

For npm installs, refresh the package first, then re-run install (idempotent):

```bash
npm install -g @sdsrs/agentsmd@latest
agentsmd install
# …or one-shot, no global install:
npx --package @sdsrs/agentsmd@latest agentsmd install
```

Plugin updates refresh the configured marketplace snapshot, then reinstall the
plugin from that marketplace. In the plugin browser, open agentsmd and reinstall
or update it from the marketplace entry. Start a new Codex thread after
reinstall so newly packaged skills/hooks are loaded.

For CLIs with `codex plugin` automation:

```bash
codex plugin marketplace upgrade agentsmd --json
codex plugin add agentsmd --marketplace agentsmd --json
```

## Uninstall

Standalone uninstall removes agentsmd's owned runtime entries while
preserving other plugins and user config:

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --uninstall

# from a checkout:
node scripts/uninstall.js
```

Uninstall preflights ownership, then transactionally removes registered hooks,
skills, the `AGENTS.md` block, install manifest, known session runtime state, and
extended spec. Snapshot checks and rollback refuse to overwrite changes observed
before their final filesystem operation. POSIX filesystems do not provide a
portable compare-and-replace primitive, so a non-cooperating writer in the narrow
check-to-rename/unlink interval remains outside that guarantee.
Recovery snapshots under `.agentsmd-state/backups/` and unknown/foreign state
entries are deliberately retained, so the state directory usually remains. Per §5 it
**leaves `config.toml` hook/status-line settings enabled** (removing them could
break oh-my-codex, your own hooks, or your preferred footer). It also leaves
tiny unregistered no-op hook shims under `$CODEX_HOME/agentsmd/hooks/` so a
currently running Codex session that cached the old hook commands exits cleanly
instead of failing with `bash` exit 127; a later install overwrites those shims
with the real hooks.

For npm installs, uninstall agentsmd's Codex footprint before removing the
global package:

```bash
agentsmd uninstall
npm uninstall -g @sdsrs/agentsmd
```

Plugin uninstall removes the Codex plugin install/cache entry. In the plugin
browser, open agentsmd and select **Uninstall plugin**. Remove the marketplace
too if you do not want Codex to keep tracking this repo as a source.

For CLIs with `codex plugin` automation:

```bash
codex plugin remove agentsmd --marketplace agentsmd --json
codex plugin marketplace remove agentsmd --json
```

If you installed both the standalone and plugin paths, run both cleanup flows;
they manage different Codex surfaces.

### Upgrading from codexmd

If you previously installed **codexmd** (v1.4.0–v1.4.3), running the agentsmd installer detects its hooks and manifest. It migrates only legacy artifacts whose provenance can be verified; an ambiguous or modified same-named directory is preserved and reported instead of being deleted.

## How is it independent of oh-my-codex?

agentsmd identifies its shared `hooks.json` entries by the active `CODEX_HOME/agentsmd` command path and its `AGENTS.md` block by sentinels. Deploy, extended spec, and skills require manifest-recorded exact paths and content hashes. Install/update stages a complete tree and validates ownership before mutation; uninstall uses the same preflight. Snapshot-checked writes, deletes, and rollback preserve external bytes detected before the final filesystem operation; the portable check-to-rename/unlink interval cannot exclude a non-cooperating writer. Legacy manifests are copied to a persistent owner-only `.agentsmd-legacy-backup-*` before hash baselining. For `config.toml`, the installer sets missing hook/status-line values but uninstall leaves them enabled. Fixtures cover OMX coexistence, ownership collisions, failure injection, mode preservation, and concurrent writes.

OMX (if present) is an orchestration framework; agentsmd is the discipline/enforcement layer. They are complementary — and agentsmd does not depend on OMX.

## Governance — opportunity-aware operator review

```bash
node scripts/audit.js --days=30    # aggregate rule-hit telemetry by spec section
node scripts/audit.js --project=X  # …scoped to projects whose path contains "X" (also on rules — informational lens, now with per-rule local hits)
node scripts/rules.js --days=30    # promote/demote signals vs spec/hard-rules.json
```

A hook rule becomes a demotion candidate only after enough rule-specific evaluated opportunities with zero enforcement hits. `no-opportunity`, low evaluation, and global session counts are not evidence for demotion; high hits show activity, not correctness. The operator decides using `spec/OPERATOR.md`.

## Generate a project-level AGENTS.md

agentsmd installs the **global** discipline spec into `~/.codex/AGENTS.md` (the universal *how*). To scaffold a **project** `AGENTS.md` (this repo's *what* — stack, structure, commands), run from the project root:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/init.js"   # or the agentsmd-init skill
```

It detects Node/Rust/Python/Go, writes a sentinel-delimited managed block, and re-running updates it in place while preserving your own edits. `--check` reports drift; `--dry-run` previews. `--check`, `--dry-run`, and `--local` are mutually exclusive execution modes.

Add `--local` to also scaffold a git-ignored `AGENTS.local.md` for personal preferences (e.g. `AUTONOMY_LEVEL`) that never leave your machine:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/init.js" --local
```

It's create-only (never clobbers an existing `AGENTS.local.md`) and idempotently adds the filename to `.gitignore`. Codex only reads it once you add `AGENTS.local.md` to `project_doc_fallback_filenames` in `~/.codex/config.toml` — `init --local` prints the exact line to add.

`agentsmd init` is frontend-aware: when it detects a frontend framework
(React/Vue/Svelte/Angular/Solid/Preact, incl. meta-frameworks like
Next/Nuxt/Remix/Astro/SvelteKit, and UI libraries like Tailwind/MUI/shadcn), it
adds a deterministic `## Frontend` section (stack facts + short per-stack
conventions) to the managed block. Vite is noted as a build-tool label when a
base framework is present, not a standalone trigger. Pass `--no-frontend` to
skip it. Non-frontend projects are unaffected.

## Distill project conventions

`init` only detects stack *facts* (language, package manager, commands). To also capture a project's *implicit* conventions — naming, import order, error handling, comment style — from its own source, run the `agentsmd-analyze` skill from within a Codex session, or drive its deterministic half directly:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/analyze.js" --gather
```

`--gather` prints a capped, ignore-aware source-file map (default when no flag is given). Reading that map and distilling it into conventions is the one AI step — done by the `agentsmd-analyze` skill, not this script. `--write --from <file>` then injects the result into the project `AGENTS.md`'s `agentsmd:conventions` block, refusing — never truncating — past a 6 KiB conventions / ~32 KiB whole-file budget.

## Convention adoption — is anyone citing what you distilled?

`analyze --write` stamps each recognized convention heading with a stable `@conv-<dim>` anchor and a citation instruction, so distilled conventions get the same "cite it or it decays" treatment this repo already applies to its own memory lessons. A Stop hook (`convention-cite-scan`) watches your own output for those citations and records one `cite` event per known anchor actually named — an anchor the AI invents that isn't in *this* project's `AGENTS.md` is never recorded. See which dimensions are earning their keep:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/analyze.js" --adoption
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/analyze.js" --adoption --days=7 --project=X
```

A dimension with zero cites is a manual review prompt, not pruning evidence: the citation layer does not yet record per-anchor evaluated opportunities. Nothing is deleted automatically. `@conv-*` citation counts remain separate from the global `§*` enforcement ledger.

## Capture design tokens

For a frontend project, `agentsmd design` extracts the design tokens — CSS `:root` custom properties and Tailwind v4 `@theme` — into a **facts-only `DESIGN.md`** (a sentinel-managed block) plus a one-line pointer appended to `AGENTS.md`. It keeps `AGENTS.md` lean (the pointer, not the tokens); the agent reads `DESIGN.md` on demand.

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/design.js"           # preview — writes nothing
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/design.js" --write   # commit DESIGN.md + the pointer
```

It's deterministic (tokens are facts — no AI step, unlike `analyze`), command-only, and consent-gated (previews by default). Tokens are grouped by category (colors / spacing / typography / radii / shadows / …); the managed block is budget-guarded (refuses, never truncates). A non-frontend project is a no-op; a Tailwind v3 project whose theme lives in `tailwind.config.js` gets an honest note pointing there (config-object parsing is a future extension).

## Develop

```bash
npm test    # install/independence + closed-loop telemetry + drift + distribution + hook smoke suites
```

`scripts/tests/drift.test.js` is the CI gate that keeps `spec/`, `hard-rules.json`, both hook wirings, and the version in sync. Architecture and phase history: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Layout

```
bin/         npm CLI entry — the `agentsmd` CLI dispatcher over scripts/
spec/        canonical spec (core, extended, changelog, hard-rules.json, OPERATOR.md)
hooks/       L1 enforcement — the native hooks + shared lib + smoke test
scripts/     L2 management — install/uninstall/status/doctor/audit/rules (+ migrate + tests)
skills/      L3 command layer — one agentsmd-* skill stub per user-facing script (see skills/)
.agents/     repo marketplace metadata pointing Codex at the pinned npm artifact
.codex-plugin/plugin.json   Codex plugin manifest
hooks.json   plugin-root hook wiring (relative paths)
install.sh   curl-friendly standalone installer/updater/uninstaller
```

## FAQ

**Is agentsmd the same as codexmd?**
Yes. `codexmd` was the former name; the project was renamed to `agentsmd` in v2.0.0 to match its repository. Same system, same `CODEX-CODING-SPEC`; only the tool's identity changed. Legacy artifacts are migrated only when their provenance is verifiable.

**Do I need oh-my-codex to use agentsmd?**
No. agentsmd installs and runs standalone. If OMX happens to be installed, the two coexist without touching each other's config.

**Does it work with plain OpenAI Codex CLI?**
The standalone installer targets the native hook configuration and `doctor`
checks the deployed wiring, executability, dependencies, flag, manifest, and
spec inventory. The smoke suite exercises snake_case fixtures and the
block/advisory/context JSON shapes; compatibility outside those fixtures remains
dependent on the Codex runtime version.

**Will it modify my existing `~/.codex` config?**
Only its identified shared entries and manifest-owned standalone artifacts. It refuses an unparseable shared file or an artifact whose current hash no longer matches the manifest; existing model/profile/plugin settings outside its managed blocks remain outside the mutation set.

**How do I update or remove it?**
Standalone: re-run the curl installer or `node scripts/install.js`; remove with
`install.sh --uninstall` or `node scripts/uninstall.js`. npm: re-run
`npm install -g @sdsrs/agentsmd@latest` then `agentsmd install` (or a one-shot
`npx --package @sdsrs/agentsmd@latest agentsmd install`); remove with `agentsmd
uninstall` then `npm uninstall -g @sdsrs/agentsmd`. Plugin: use the Codex plugin browser
(`codex` then `/plugins`, or the app's **Plugins** page) to update or uninstall;
newer CLIs can also run `codex plugin marketplace upgrade agentsmd` then
`codex plugin add agentsmd --marketplace agentsmd`, and remove with
`codex plugin remove agentsmd --marketplace agentsmd`.

## License

MIT
