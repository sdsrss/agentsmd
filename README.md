# agentsmd

**English · [中文](./README.zh-CN.md)**

> A coding-discipline spec for **OpenAI's Codex CLI**, made enforceable by native Codex hooks and kept honest by a rule-hit telemetry loop. It turns a spec the model can drift from into a system that actually holds — and it installs standalone, fully independent of oh-my-codex.

![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![hooks](https://img.shields.io/badge/hooks-native%20Codex-blue) ![independent](https://img.shields.io/badge/independent%20of-oh--my--codex-orange)

> **Formerly `codexmd`.** The project was renamed to `agentsmd` in v2.0.0 to match its repository. Installing agentsmd automatically migrates a prior codexmd install — [details below](#upgrading-from-codexmd).

---

## What is agentsmd?

**agentsmd is a global coding-discipline spec for the Codex CLI that Codex's own hooks enforce.** The spec — `spec/AGENTS.md` (always-on core) plus `spec/AGENTS-extended.md` (loaded on demand) — defines a `CLASSIFY → AUTH → ROUTE → PLAN → EXECUTE → VALIDATE → REPORT` workflow, level-based rigor, Iron Laws (no "done" without fresh evidence; no fix without a root cause), a §8 SAFETY floor, and honest four-section reporting. Native Codex hooks make the mechanical parts **non-optional**, and every rule-hit is logged so **data — not taste — decides which rules earn a place in the always-on layer.**

## Why hooks and telemetry, not just an `AGENTS.md`?

A spec file is only as strong as the model's willingness to follow it mid-session. The real cost of a long rule list is **attention dilution**: the more rules you write, the weaker each one's pull in the middle of a long task — and that cost is invisible to any token count.

agentsmd answers this the way a system does, not a document:

- **Hooks** turn the mechanical rules (block `rm -rf $VAR`, block unquantified commit-message claims, block a push onto a red-CI branch) into deterministic gates the model cannot talk its way past.
- **Telemetry** records every hit, so `agentsmd-rules` can show which always-on rules keep firing (they earn their place) and which never fire (they are pure dilution — demote them).

The point isn't saving tokens. **A rule nobody enforces and nobody triggers is pure attention dilution.** agentsmd exists to keep every rule enforceable and every always-on rule justified by data.

## What it enforces

Ten native hooks across all five Codex events. The blocking ones are hard gates; the Stop-time ones queue an advisory that surfaces at your next prompt.

| Hook | Event | Enforces |
|---|---|---|
| `pre-bash-safety-check` | PreToolUse:Bash | §8 SAFETY — blocks `rm -rf $VAR`, `curl \| bash`; warns on unpinned `npx` |
| `banned-vocab-check` | PreToolUse:Bash | §10 — blocks unquantified value claims in `git commit` messages |
| `ship-baseline-check` | PreToolUse:Bash | §E3 — blocks `git push` to a shared branch while its CI is red |
| `memory-read-check` | PreToolUse:Bash | §7 — blocks a ship when a project `MEMORY.md` was not consulted |
| `session-start-check` | SessionStart | injects the active-spec banner; resets the advisory queue |
| `surface-advisories` | UserPromptSubmit | surfaces advisories the Stop hooks queued last turn |
| `memory-prompt-hint` | UserPromptSubmit | surfaces `MEMORY.md` entries matching the prompt |
| `residue-audit` | Stop | §7/§9 — flags `~/.codex/tmp` growth |
| `sandbox-disposal-check` | Stop | §8.V4 — flags undisposed scratch dirs |
| `transcript-structure-scan` | Stop | §10 — checks four-section order + banned vocab in the last report |

Stop-hook advisories are queued and surfaced at the next `UserPromptSubmit` (the verified `additionalContext` channel), not emitted inline on Stop. Every hit is appended to `~/.codex/logs/agentsmd.jsonl`.

## Requirements

- **Codex CLI** with native hooks enabled — `config.toml` → `[features] hooks = true`. The installer sets this and migrates the pre-0.142 `codex_hooks` name automatically. It also restores a useful built-in TUI footer with `[tui] status_line` when the user has not already configured one.
- **`jq`** and **`node` ≥ 18** on `PATH`.

Everything honors `$CODEX_HOME` (defaults to `~/.codex`).

## Install

Choose one install surface:

- **Standalone curl installer:** shortest path for most local Codex CLI users.
- **npm package:** a version-pinned global `agentsmd` CLI (`npm install -g
  @sdsrs/agentsmd`), or a one-shot via `npx --package`.
- **Codex plugin marketplace:** use Codex's plugin browser; newer CLIs also
  expose automation commands.
- **Local checkout:** for development or reviewing changes before installing.

### Standalone installer

Use this when you want agentsmd to manage its own marker-scoped entries in
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

`agentsmd --help` lists every subcommand: `init` · `analyze` · `install` ·
`update` · `uninstall` · `status` · `doctor` · `audit` · `rules`. A bare
`agentsmd` prints help and installs nothing.

### Codex plugin marketplace

Use this when you want Codex to install agentsmd as a plugin and keep the bundle
in Codex's plugin cache. The repo ships a marketplace at
`.agents/plugins/marketplace.json`; its marketplace name is `agentsmd`.

> **What the plugin path wires — and what it doesn't.** Codex auto-manages
> agentsmd's **hooks** from the plugin bundle. The rest of a full install —
> injecting the core spec into `~/.codex/AGENTS.md`, setting `config.toml`
> `[features] hooks = true`, and migrating a prior codexmd install — is done by
> the script installer, **not** by plugin install. For the complete experience,
> run the installer once after adding the plugin:
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

Install is **idempotent** and preserves every other tenant's entries byte-for-byte.

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

Standalone uninstall removes agentsmd's own entries and cleanup state while
preserving other plugins and user config:

```bash
curl -fsSL https://raw.githubusercontent.com/sdsrss/agentsmd/main/install.sh | sh -s -- --uninstall

# from a checkout:
node scripts/uninstall.js
```

Uninstall strips only agentsmd's own entries (hooks, skills, the `AGENTS.md` block, the install + state dirs) and, per §5, **leaves `config.toml` hook/status-line settings enabled** (removing them could break oh-my-codex, your own hooks, or your preferred footer).

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

If you previously installed **codexmd** (v1.4.0–v1.4.3), you don't need to do anything special: **running the agentsmd installer migrates you automatically.** It strips hooks under the old `CODEX_HOME/codexmd` install dir, the `# >>> codexmd >>>` `AGENTS.md` block, the `codexmd-*` skills, and `~/.codex/{codexmd, .codexmd-state}` — marker-scoped, so oh-my-codex and every other tenant are left untouched. The migration is a no-op if no codexmd install is present, and `uninstall` sweeps any codexmd remnant too.

## How is it independent of oh-my-codex?

agentsmd manages **only its own entries** in the shared `~/.codex/hooks.json`, `config.toml`, and `AGENTS.md`, identified by the active `CODEX_HOME/agentsmd` install-dir marker in hook commands and `# >>> agentsmd >>>` sentinels. For `config.toml`, it sets `[features] hooks = true` and fills `[tui] status_line` only when missing; an existing user footer is preserved. It never reads, modifies, reorders, or depends on oh-my-codex (OMX) or any other tenant, and it installs cleanly whether or not OMX is present. If the shared `hooks.json` is ever unparseable, the installer **aborts rather than clobber** it — it may hold other tenants' hooks it cannot see. This is proven by `scripts/tests/install.test.js`, which asserts a byte-identical round-trip alongside a seeded OMX config.

OMX (if present) is an orchestration framework; agentsmd is the discipline/enforcement layer. They are complementary — and agentsmd does not depend on OMX.

## Governance — let data decide which rules stay

```bash
node scripts/audit.js --days=30    # aggregate rule-hit telemetry by spec section
node scripts/audit.js --project=X  # …scoped to projects whose path contains "X" (also on rules)
node scripts/rules.js --days=30    # promote/demote signals vs spec/hard-rules.json
```

A hook-enforced rule with **zero hits** over a review window is always-on-layer dilution → a demote candidate. A high-hit rule justifies its place in the core. Operator cadence, size budget, and promote/demote gates live in `spec/OPERATOR.md`.

## Generate a project-level AGENTS.md

agentsmd installs the **global** discipline spec into `~/.codex/AGENTS.md` (the universal *how*). To scaffold a **project** `AGENTS.md` (this repo's *what* — stack, structure, commands), run from the project root:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/init.js"   # or the agentsmd-init skill
```

It detects Node/Rust/Python/Go, writes a sentinel-delimited managed block, and re-running updates it in place while preserving your own edits. `--check` reports drift; `--dry-run` previews.

Add `--local` to also scaffold a git-ignored `AGENTS.local.md` for personal preferences (e.g. `AUTONOMY_LEVEL`) that never leave your machine:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/init.js" --local
```

It's create-only (never clobbers an existing `AGENTS.local.md`) and idempotently adds the filename to `.gitignore`. Codex only reads it once you add `AGENTS.local.md` to `project_doc_fallback_filenames` in `~/.codex/config.toml` — `init --local` prints the exact line to add.

## Distill project conventions

`init` only detects stack *facts* (language, package manager, commands). To also capture a project's *implicit* conventions — naming, import order, error handling, comment style — from its own source, run the `agentsmd-analyze` skill from within a Codex session, or drive its deterministic half directly:

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/analyze.js" --gather
```

`--gather` prints a capped, ignore-aware source-file map (default when no flag is given). Reading that map and distilling it into conventions is the one AI step — done by the `agentsmd-analyze` skill, not this script. `--write --from <file>` then injects the result into the project `AGENTS.md`'s `agentsmd:conventions` block, refusing — never truncating — past a 6 KiB conventions / ~32 KiB whole-file budget.

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
skills/      L3 command layer — agentsmd-init/analyze/audit/rules/doctor/status
.agents/     repo marketplace metadata for Codex plugin browser/CLI installs
.codex-plugin/plugin.json   Codex plugin manifest
hooks.json   plugin-root hook wiring (relative paths)
install.sh   curl-friendly standalone installer/updater/uninstaller
```

## FAQ

**Is agentsmd the same as codexmd?**
Yes. `codexmd` was the former name; the project was renamed to `agentsmd` in v2.0.0 to match its repository. Same system, same `CODEX-CODING-SPEC`; only the tool's identity changed. Existing codexmd installs are migrated automatically.

**Do I need oh-my-codex to use agentsmd?**
No. agentsmd installs and runs standalone. If OMX happens to be installed, the two coexist without touching each other's config.

**Does it work with plain OpenAI Codex CLI?**
Yes — it targets the Codex CLI's native hook system (`[features] hooks = true`, Codex 0.142+). It reads snake_case hook stdin and emits the Codex block/advisory/context JSON shapes.

**Will it modify my existing `~/.codex` config?**
Only its own marker-scoped entries, and it refuses to touch an unparseable `hooks.json`. Your model, profiles, and other plugins' entries are preserved byte-for-byte.

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
